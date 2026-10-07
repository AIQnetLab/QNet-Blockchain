// qnet_signMessage in the app signs exactly what the QNet browser extension signs: the same bytes for every
// (origin, message), the same refusals, the same FIPS 204 context. The vectors come from the extension's own
// bundle (scripts/offchain-message-vectors.mjs), including a signature by the wallet KAT key.
const { ml_dsa65 } = require('@noble/post-quantum/ml-dsa.js');
const V = require('./fixtures/offchain_message_vectors.json');
const KAT = require('./fixtures/wallet_kat.json');
const {
  buildOffchainMessage, signOffchainMessage, verifyOffchainMessage, OFFCHAIN_MESSAGE_HEADER, OFFCHAIN_MESSAGE_CONTEXT,
  OFFCHAIN_MESSAGE_MAX_BYTES, PROTOCOL_PREFIXES,
} = require('../src/crypto/OffchainMessage');

const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));

// The wallet key of the KAT phrase, from the golden KeyGen seed: noble's FIPS 204 KeyGen gives the node's
// public key, so its secret key has the encoding the native module stores.
const KEYS = ml_dsa65.keygen(unhex(KAT.xi_shake256));

it('uses the extension\'s header, context, size limit and protocol prefixes', () => {
  expect(OFFCHAIN_MESSAGE_HEADER).toBe(V.header);
  expect(OFFCHAIN_MESSAGE_CONTEXT).toBe(V.context);
  expect(OFFCHAIN_MESSAGE_MAX_BYTES).toBe(V.max_bytes);
  expect([...PROTOCOL_PREFIXES]).toEqual(V.protocol_prefixes);
  expect(PROTOCOL_PREFIXES).toEqual(expect.arrayContaining(['register:', 'migrate:']));
  // The shared list (A1/A2): the payment address's owner bind and aiqnet.io's two records join it, folded.
  expect([...PROTOCOL_PREFIXES]).toEqual(['q1337|', 'qnet_register:', 'qnet_onchain_reg:', 'delegate_ping:', 'token_refresh:',
    'ping:', 'selfattest:', 'register:', 'migrate:', 'client_node_reg:', 'claim_rewards:', 'qnet_claim_v1:', 'qnet_dev_',
    'qnet_burn_owner_v2:', 'qnetburnrecordv1', 'qnetnodereservationv1']);
});

// The fixture alone cannot notice a change on the extension's side: read the shipped bundle itself, and run
// the generator's staleness check, so a prefix or rule added to either wallet fails here.
describe('parity with the shipped extension bundle', () => {
  const { execFileSync } = require('child_process');
  const path = require('path');
  const bundle = path.resolve(__dirname, '../../qnet-wallet/dist/lib/qnet-core.js');

  it('has exactly the bundle\'s protocol prefixes', () => {
    const script = `import(${JSON.stringify(require('url').pathToFileURL(bundle).href)})`
      + '.then((c) => process.stdout.write(JSON.stringify(c.PROTOCOL_PREFIXES)))';
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect([...PROTOCOL_PREFIXES]).toEqual(JSON.parse(out));
  });

  it('the committed vectors are what the bundle generates now', () => {
    const script = path.resolve(__dirname, '../scripts/offchain-message-vectors.mjs');
    const out = execFileSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
    expect(out).toMatch(/up to date/);
  });

  it('refuses the registration and migration preimages, plain and disguised', () => {
    const refuse = (m) => expect(() => buildOffchainMessage('https://example.com', m)).toThrow('PROTOCOL_PREFIX');
    refuse('register:02dca74ef2eae3be97feon499504db891ae0c60e364a8:QNET-L1234:light');
    refuse('migrate:QNET-L1234:ab12');
    refuse(' Register:x');
    refuse('ｒｅｇｉｓｔｅｒ:x');
    expect(() => buildOffchainMessage('https://example.com', 'Please register: your seat')).not.toThrow();
  });
});

it('builds the extension\'s bytes for every vector and refuses what it refuses', () => {
  expect(V.build.length).toBeGreaterThan(30);
  for (const v of V.build) {
    let got;
    try {
      got = { bytes_hex: hex(buildOffchainMessage(v.origin, v.message)) };
    } catch (e) {
      got = { error: e.code };
    }
    const want = v.error ? { error: v.error } : { bytes_hex: v.bytes_hex };
    expect([v.origin, v.message.slice(0, 24), got]).toEqual([v.origin, v.message.slice(0, 24), want]);
  }
});

it('refuses exactly the code points the extension refuses inside a message', () => {
  expect(V.refused_code_points.length).toBeGreaterThan(100);
  const want = new Set();
  for (const [a, b] of V.refused_code_points) for (let cp = a; cp <= b; cp += 1) want.add(cp);
  const { hasHiddenCharacter } = require('../src/crypto/OffchainMessage');
  // The one allowed difference: a code point unassigned in the generator's Unicode version (the vectors were
  // written by this Node, whose runtime tables a RegExp built at run time uses) that the build's newer Unicode
  // data assigns. Everything else must match exactly.
  const unassignedHere = new RegExp('^\\p{Cn}$', 'u');
  const differ = [];
  let newlyAssigned = 0;
  for (let cp = 0; cp <= 0x10ffff; cp += 1) {
    const ch = String.fromCodePoint(cp);
    const phone = hasHiddenCharacter(`a${ch}b`);
    if (phone === want.has(cp)) continue;
    if (!phone && unassignedHere.test(ch)) newlyAssigned += 1;
    else differ.push(cp.toString(16));
  }
  expect(differ.slice(0, 20)).toEqual([]);
  expect(newlyAssigned).toBeLessThan(10_000);
  // The predicate is what buildOffchainMessage refuses by.
  for (const cp of [0x200b, 0x2060, 0xfeff, 0xad, 0x34f, 0xe0041, 0xfe0f, 0x2800, 0x3164, 0x2028, 0xe000, 0x378]) {
    expect(() => buildOffchainMessage('https://example.com', `a${String.fromCodePoint(cp)}b`)).toThrow('INVALID_MESSAGE');
  }
});

it('refuses a disguised protocol prefix: behind hidden or space characters, or in compatibility forms', () => {
  const refuse = (m, code) => expect(() => buildOffchainMessage('https://example.com', m)).toThrow(code);
  refuse('​q1337|transfer:a:b:1:0:10:10000', 'INVALID_MESSAGE');
  refuse('\u{E0071}1337|x', 'INVALID_MESSAGE');
  refuse('p i n g:abc', 'PROTOCOL_PREFIX');
  refuse('　ping:abc', 'PROTOCOL_PREFIX');
  refuse('ｑ１３３７|x', 'PROTOCOL_PREFIX');
  refuse('Log in to example.com\u{E0020}\u{E0061}', 'INVALID_MESSAGE');
  expect(() => buildOffchainMessage('https://example.com', 'Hello ping:abc')).not.toThrow();
});

it('without a working NFKC, refuses non-ASCII where a prefix could sit instead of missing it', () => {
  const { _foldForPrefixCheck } = require('../src/crypto/OffchainMessage');
  expect(_foldForPrefixCheck('ｑ１３３７|x', false)).toBeNull();
  expect(_foldForPrefixCheck('café menu', false)).toBeNull();
  expect(_foldForPrefixCheck('Hello, this is a long ASCII head: café', false)).toBe('hello,thisisalongasciihead:café');
  expect(_foldForPrefixCheck('ｑ１３３７|x', true)).toBe('q1337|x');
});

it('the KAT key is the node\'s, and verifies the extension\'s signature', () => {
  expect(hex(KEYS.publicKey)).toBe(KAT.pk_hex);
  const s = V.signature;
  expect(verifyOffchainMessage(s.origin, s.message, unhex(s.signature_hex), KEYS.publicKey)).toBe(true);
  expect(verifyOffchainMessage('https://evil.example', s.message, unhex(s.signature_hex), KEYS.publicKey)).toBe(false);
  expect(verifyOffchainMessage(s.origin, `${s.message}.`, unhex(s.signature_hex), KEYS.publicKey)).toBe(false);
});

it('signs with the context, so the signature is no transaction signature (empty context)', () => {
  const signed = signOffchainMessage('https://dapp.example', 'Log in', KEYS.secretKey, KEYS.publicKey);
  expect(signed.address).toBe(KAT.eon_address);
  const bytes = buildOffchainMessage('https://dapp.example', 'Log in');
  expect(ml_dsa65.verify(signed.signature, bytes, KEYS.publicKey, { context: new TextEncoder().encode(V.context) })).toBe(true);
  expect(ml_dsa65.verify(signed.signature, bytes, KEYS.publicKey)).toBe(false);
  expect(verifyOffchainMessage('https://dapp.example', 'Log in', signed.signature, KEYS.publicKey)).toBe(true);
});

it('refuses protocol messages and hidden text before anything is signed', () => {
  for (const m of ['q1337|transfer:a:b:1:0:10:10000', ' ping:v2:ab:1', 'SELFATTEST:1', 'a\u202eb', '']) {
    expect(() => signOffchainMessage('https://dapp.example', m, KEYS.secretKey, KEYS.publicKey)).toThrow();
  }
});

// C3: the site-record signer builds the same envelope for aiqnet.io's burn record and node reservation only; both carry
// a protocol prefix, so no website can have either signed through qnet_signMessage.
describe('the site-record signer', () => {
  const {
    buildSiteRecord, signSiteRecord, nodeReservationMessage, hasProtocolPrefix, SITE_RECORD_HEADS, _foldForPrefixCheck,
  } = require('../src/crypto/OffchainMessage');
  const CONTEXT = new TextEncoder().encode(V.context);
  const BURNER = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';

  it('builds the extension\'s bytes for every site-record vector and refuses what it refuses', () => {
    expect(V.site_record.length).toBeGreaterThanOrEqual(10);
    expect(V.site_record.filter((v) => !v.error).length).toBeGreaterThanOrEqual(2);
    for (const v of V.site_record) {
      let got;
      try {
        got = { bytes_hex: hex(buildSiteRecord(v.origin, v.message)) };
      } catch (e) {
        got = { error: e.code };
      }
      const want = v.error ? { error: v.error } : { bytes_hex: v.bytes_hex };
      expect([v.origin, v.message.slice(0, 32), got]).toEqual([v.origin, v.message.slice(0, 32), want]);
    }
  });

  it('a record is never a dApp message, a dApp message never a record, and both have the same envelope', () => {
    expect(SITE_RECORD_HEADS).toEqual(['QNet burn record v1\n', 'QNet node reservation v1\n']);
    for (const v of V.site_record.filter((x) => !x.error)) {
      expect(hasProtocolPrefix(v.message)).toBe(true);
      expect(() => buildOffchainMessage(v.origin, v.message)).toThrow('PROTOCOL_PREFIX');
      const body = Buffer.from(v.message, 'utf8');
      expect(hex(buildSiteRecord(v.origin, v.message)))
        .toBe(Buffer.concat([Buffer.from(`${V.header}${v.origin}\n${body.length}\n`), body]).toString('hex'));
    }
    for (const m of ['Hello', 'Sign in to example.com\nNonce: 8f2c1d', ' QNet burn record v1\nx', 'QNet node reservation v2\nx']) {
      expect(() => buildSiteRecord('https://aiqnet.io', m)).toThrow('INVALID_MESSAGE');
    }
    // Without a working NFKC, a non-ASCII character where the longest prefix (21 characters) could sit refuses the text.
    expect(Math.max(...PROTOCOL_PREFIXES.map((p) => p.length))).toBe(21);
    expect(_foldForPrefixCheck('qnetnodereservationıı', false)).toBeNull();
    expect(_foldForPrefixCheck('QNet node reservation v1\nwallet', false)).toBe('qnetnodereservationv1wallet');
  });

  it('verifies the extension\'s site-record signature, and signs the same way, self-checked', () => {
    const s = V.site_record_signature;
    expect(s.address).toBe(KAT.eon_address);
    const bytes = buildSiteRecord(s.origin, s.message);
    expect(ml_dsa65.verify(unhex(s.signature_hex), bytes, KEYS.publicKey, { context: CONTEXT })).toBe(true);
    const signed = signSiteRecord(s.origin, s.message, KEYS.secretKey, KEYS.publicKey);
    expect(signed.address).toBe(KAT.eon_address);
    expect(ml_dsa65.verify(signed.signature, bytes, KEYS.publicKey, { context: CONTEXT })).toBe(true);
    expect(ml_dsa65.verify(signed.signature, bytes, KEYS.publicKey)).toBe(false); // never a transaction signature
    expect(() => signSiteRecord(s.origin, 'Log in', KEYS.secretKey, KEYS.publicKey)).toThrow('INVALID_MESSAGE');
    expect(() => signSiteRecord(s.origin, s.message, KEYS.secretKey.slice(1), KEYS.publicKey)).toThrow('INVALID_KEY');
  });

  it('the node reservation: the exact text of its facts, and nothing malformed', () => {
    const facts = { wallet: KAT.eon_address, nodeType: 'light', way: 'payment', burner: BURNER, time: 1790000000, cluster: 'devnet' };
    expect(nodeReservationMessage(facts)).toBe(V.site_record_signature.message);
    expect(nodeReservationMessage({ ...facts, nodeType: 'super', way: 'extension' })).toMatch(/\nnode: super\nway: extension\nburner: /);
    for (const bad of [{ nodeType: 'super' }, { way: 'phone' }, { nodeType: 'full' }, { wallet: `${KAT.eon_address.slice(0, -1)}0` },
      { burner: 'x' }, { time: -1 }, { time: 1.5 }, { time: '1790000000' }, { cluster: 'Devnet' }, { cluster: 'devnet\nx' }]) {
      expect(() => nodeReservationMessage({ ...facts, ...bad })).toThrow('INVALID_MESSAGE');
    }
  });
});

describe('the wallet signs a site\'s message with its own key, once, and wipes it', () => {
  const { WalletManager } = require('../src/components/WalletManager');

  it('decrypts for this signature only and returns hex', async () => {
    const wm = new WalletManager();
    const privateKey = Array.from(KEYS.secretKey);
    wm.loadWallet = jest.fn(async () => ({
      qnetAddress: KAT.eon_address,
      qnetKeypair: { publicKey: Array.from(KEYS.publicKey), privateKey, path: 'QNET_WALLET_MLDSA65_fips204' },
    }));
    const r = await wm.signOffchainMessage('https://dapp.example', 'Hello', 'qnet-session:t');
    expect(wm.loadWallet).toHaveBeenCalledWith('qnet-session:t');
    expect(r.address).toBe(KAT.eon_address);
    expect(r.publicKey).toBe(KAT.pk_hex);
    expect(verifyOffchainMessage('https://dapp.example', 'Hello', unhex(r.signature), KEYS.publicKey)).toBe(true);
    expect(privateKey.every((b) => b === 0)).toBe(true);
  });

  it('refuses a key that is not its address', async () => {
    const wm = new WalletManager();
    wm.loadWallet = jest.fn(async () => ({
      qnetAddress: '02dca74ef2eae3be97feon499504db891ae0c60e364a8',
      qnetKeypair: { publicKey: Array.from(KEYS.publicKey), privateKey: Array.from(KEYS.secretKey) },
    }));
    await expect(wm.signOffchainMessage('https://dapp.example', 'Hello', 't')).rejects.toThrow(/does not match/);
  });

  // A1, the payment way: the QNet Link `reserve` sheet's signature, a site record for the site's own origin.
  const BURNER = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
  const walletWith = (privateKey, address = KAT.eon_address) => {
    const wm = new WalletManager();
    wm.loadWallet = jest.fn(async () => ({
      qnetAddress: address,
      qnetKeypair: { publicKey: Array.from(KEYS.publicKey), privateKey, path: 'QNET_WALLET_MLDSA65_fips204' },
    }));
    return wm;
  };

  it('signs its light node\'s reservation for aiqnet.io\'s origin, once, and wipes the key', async () => {
    const { buildSiteRecord } = require('../src/crypto/OffchainMessage');
    const privateKey = Array.from(KEYS.secretKey);
    const wm = walletWith(privateKey);
    const r = await wm.signNodeReservation('qnet-session:t', { burner: BURNER, time: 1790000000 });
    expect(wm.loadWallet).toHaveBeenCalledWith('qnet-session:t');
    expect(Object.keys(r).sort()).toEqual(['address', 'pk', 'sig']);
    expect(r.address).toBe(KAT.eon_address);
    expect(Buffer.from(r.pk, 'base64url').toString('hex')).toBe(KAT.pk_hex);
    // The message of its own facts: this wallet, a light node, the payment way, the one-time address and T.
    const message = `QNet node reservation v1\nwallet: ${KAT.eon_address}\nnode: light\nway: payment\nburner: ${BURNER}\n`
      + 'time: 1790000000\ncluster: devnet';
    expect(message).toBe(V.site_record_signature.message);
    const sig = Uint8Array.from(Buffer.from(r.sig, 'base64url'));
    expect(sig).toHaveLength(3309);
    const context = { context: new TextEncoder().encode(V.context) };
    expect(ml_dsa65.verify(sig, buildSiteRecord('https://aiqnet.io', message), KEYS.publicKey, context)).toBe(true);
    expect(ml_dsa65.verify(sig, buildSiteRecord('https://evil.example', message), KEYS.publicKey, context)).toBe(false);
    expect(privateKey.every((b) => b === 0)).toBe(true);
  });

  it('refuses a malformed address or time, or a key that is not its address, and still wipes the key', async () => {
    for (const bad of [{ burner: 'not-an-address', time: 1790000000 }, { burner: BURNER, time: -5 }, { burner: BURNER, time: '1' }]) {
      const privateKey = Array.from(KEYS.secretKey);
      await expect(walletWith(privateKey).signNodeReservation('t', bad)).rejects.toThrow('INVALID_MESSAGE');
      expect(privateKey.every((b) => b === 0)).toBe(true);
    }
    const privateKey = Array.from(KEYS.secretKey);
    const other = walletWith(privateKey, '02dca74ef2eae3be97feon499504db891ae0c60e364a8');
    await expect(other.signNodeReservation('t', { burner: BURNER, time: 1790000000 })).rejects.toThrow(/does not match/);
    expect(privateKey.every((b) => b === 0)).toBe(true);
  });
});
