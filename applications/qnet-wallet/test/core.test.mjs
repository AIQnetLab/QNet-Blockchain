// Known-answer and behaviour tests of the BUILT bundle (dist/lib/qnet-core.js), offline. Cross-client
// references come from the mobile app: its KAT fixtures and its own ed25519-hd-key / bip39 packages.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QNetCore, * as core from '../dist/lib/qnet-core.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOBILE = path.resolve(HERE, '../../qnet-mobile');
const BUNDLE = path.resolve(HERE, '../dist/lib/qnet-core.js');
const fixture = (name) => JSON.parse(readFileSync(path.join(HERE, 'fixtures', name), 'utf8'));
const mobileFixture = (name) => JSON.parse(readFileSync(path.join(MOBILE, '__tests__/fixtures', name), 'utf8'));
const mobileRequire = createRequire(path.join(MOBILE, 'package.json'));
const mobilePackages = ['ed25519-hd-key', 'bs58', 'bip39'].every((p) => existsSync(path.join(MOBILE, 'node_modules', p)));
const needsMobile = mobilePackages ? {} : { skip: 'qnet-mobile/node_modules is not installed' };

const KAT_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const KAT_EON = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
const KAT_SOLANA = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const GENESIS_WALLET_001 = '4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d';
const { bytesToHex: hex, hexToBytes } = core;
const utf8 = (s) => new TextEncoder().encode(s);
const cleartextOrigin = (host) => ['http', host].join('://');
const code = (fn) => {
  try {
    fn();
  } catch (error) {
    return error instanceof core.CoreError ? error.code : `not a CoreError: ${error}`;
  }
  return 'no error';
};

function addressesOf(phrase) {
  const seed = core.mnemonicToSeed(phrase);
  const qnet = core.deriveQnetKeypair(seed);
  const solana = core.deriveSolanaKeypair(seed);
  return { qnet: qnet.address, solana: solana.address, entropy: hex(core.mnemonicToEntropy(phrase)) };
}

describe('mnemonic', () => {
  it('derives the golden EON and Solana addresses from the public recovery-phrase vector', () => {
    const vector = mobileFixture('wallet_kat.json');
    assert.equal(vector.eon_address, KAT_EON);
    const seed = core.mnemonicToSeed(KAT_MNEMONIC);
    assert.equal(hex(seed), vector.bip39_seed_hex);
    assert.equal(core.WALLET_SEED_PREFIX + hex(seed), vector.seed_string);
    assert.equal(hex(core.walletXi(seed)), vector.xi_shake256);
    const qnet = core.deriveQnetKeypair(seed);
    assert.equal(hex(qnet.publicKey), vector.pk_hex);
    assert.equal(hex(core.sha3_256(qnet.publicKey)), vector.pk_sha3_256);
    assert.equal(qnet.secretKey.length, 4032);
    assert.equal(qnet.address, KAT_EON);
    assert.equal(core.qnetAddressFromPublicKey(qnet.publicKey), KAT_EON);
    assert.equal(core.deriveSolanaKeypair(seed).address, KAT_SOLANA);
  });

  it('gives whitespace, case and NFKD variants the canonical phrase and identical addresses', () => {
    const words = KAT_MNEMONIC.split(' ');
    const variants = [
      `  ${KAT_MNEMONIC}  `,
      words.join('  '),
      words.join('\n'),
      words.join('\r\n'),
      words.join('\t'),
      `${words.slice(0, 4).join(' ')}\n${words.slice(4, 8).join(' ')}\n${words.slice(8).join(' ')}\n`,
      KAT_MNEMONIC.toUpperCase(),
      words.join(' '),
      words.join('　'),
      KAT_MNEMONIC.replace(/abandon/g, 'ａｂａｎｄｏｎ'), // fullwidth letters
    ];
    const golden = addressesOf(KAT_MNEMONIC);
    assert.deepEqual(golden, { qnet: KAT_EON, solana: KAT_SOLANA, entropy: '00'.repeat(16) });
    for (const variant of variants) {
      assert.equal(core.canonicalizeMnemonic(variant), KAT_MNEMONIC);
      assert.equal(core.validateMnemonic(variant), true);
      assert.deepEqual(addressesOf(variant), golden);
    }
  });

  it('rejects a bad checksum, unknown words and word counts other than 12 and 24', () => {
    const fifteen = `${'abandon '.repeat(14)}address`;
    if (mobilePackages) assert.equal(mobileRequire('bip39').validateMnemonic(fifteen), true);
    for (const phrase of [
      'abandon '.repeat(11) + 'abandon',
      'abandon '.repeat(11) + 'qnet',
      'abandon '.repeat(10) + 'about',
      fifteen,
      '',
      '   ',
    ]) {
      assert.equal(core.validateMnemonic(phrase), false, phrase);
      assert.equal(code(() => core.mnemonicToSeed(phrase)), 'INVALID_MNEMONIC');
      assert.equal(code(() => core.mnemonicToEntropy(phrase)), 'INVALID_MNEMONIC');
    }
    assert.equal(core.validateMnemonic(null), false);
    assert.equal(code(() => core.parseMnemonic(42)), 'INVALID_MNEMONIC');
  });

  it('never echoes the phrase in an error', () => {
    assert.equal(core.validateMnemonic(`${'zoo '.repeat(11)}wrong`), true);
    assert.throws(() => core.mnemonicToSeed(`${'zoo '.repeat(11)}zoo`), (error) =>
      error instanceof core.CoreError && error.message === 'INVALID_MNEMONIC' && !String(error.stack).includes('zoo'));
  });

  it('round-trips entropy for 12 and 24 words', () => {
    assert.equal(core.entropyToMnemonic(new Uint8Array(16)), KAT_MNEMONIC);
    const twentyFour = `${'abandon '.repeat(23)}art`;
    assert.equal(core.entropyToMnemonic(new Uint8Array(32)), twentyFour);
    assert.equal(core.validateMnemonic(twentyFour), true);
    assert.deepEqual(core.mnemonicToEntropy(twentyFour), new Uint8Array(32));
    assert.deepEqual(core.entropyToSeed(new Uint8Array(16)), core.mnemonicToSeed(KAT_MNEMONIC));
    assert.equal(code(() => core.entropyToMnemonic(new Uint8Array(20))), 'INVALID_ENTROPY');
    assert.equal(core.generateEntropy().length, 16);
    assert.equal(core.generateEntropy(24).length, 32);
    assert.notDeepEqual(core.generateEntropy(), core.generateEntropy());
    assert.equal(code(() => core.generateEntropy(15)), 'INVALID_WORD_COUNT');
    assert.deepEqual(core.MNEMONIC_WORD_COUNTS, [12, 24]);
  });

  it('derives the seed and the ML-DSA seed in buffers, equal to the phrase path and to mobile', () => {
    const bip39 = mobilePackages ? mobileRequire('bip39') : null;
    const entropies = [new Uint8Array(16).fill(0xff), new Uint8Array(32).fill(0xff)];
    for (let i = 0; i < 16; i++) entropies.push(core.generateEntropy(i % 2 === 0 ? 12 : 24));
    for (const entropy of entropies) {
      const phrase = core.entropyToMnemonic(entropy);
      const seed = core.entropyToSeed(entropy);
      assert.deepEqual(seed, core.mnemonicToSeed(phrase));
      if (bip39) assert.equal(hex(seed), bip39.mnemonicToSeedSync(phrase).toString('hex'));
      // mobile walletSeedString: the prefix and the lowercase hex of the seed
      assert.deepEqual(core.walletXi(seed), core.shake256(utf8(core.WALLET_SEED_PREFIX + hex(seed)), { dkLen: 32 }));
    }
  });

  it('uses the standard English 2048-word list (sha256 of english.txt)', () => {
    // Words 1-11 of a 12-word phrase are the first 121 bits of its entropy, so 187 phrases read out all 2048.
    const writeWord = (bytes, word, index) => {
      for (let b = 0; b < 11; b++) {
        if ((index >> (10 - b)) & 1) bytes[(word * 11 + b) >> 3] |= 0x80 >> ((word * 11 + b) & 7);
      }
    };
    const words = [];
    for (let first = 0; first < 2048; first += 11) {
      const count = Math.min(11, 2048 - first);
      const entropy = new Uint8Array(16);
      for (let k = 0; k < count; k++) writeWord(entropy, k, first + k);
      const phrase = core.entropyToMnemonic(entropy);
      words.push(...phrase.split(' ').slice(0, count));
      if (first % 176 === 0) assert.deepEqual(core.entropyToSeed(entropy), core.mnemonicToSeed(phrase));
    }
    assert.equal(words.length, 2048);
    assert.equal(hex(core.sha256(utf8(`${words.join('\n')}\n`))), '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda');
  });
});

describe('solana', () => {
  it('matches the mobile ed25519-hd-key derivation, byte for byte', needsMobile, () => {
    const { derivePath, getPublicKey } = mobileRequire('ed25519-hd-key');
    const bs58 = mobileRequire('bs58');
    const encode = (bs58.default || bs58).encode;
    const seed = core.mnemonicToSeed(KAT_MNEMONIC);
    const reference = derivePath(core.SOLANA_DERIVATION_PATH, hex(seed)).key;
    const derived = core.deriveSolanaKeypair(seed);
    assert.equal(hex(derived.privateKey), reference.toString('hex'));
    assert.equal(encode(getPublicKey(reference, false)), KAT_SOLANA);
    assert.equal(derived.address, KAT_SOLANA);
    assert.equal(core.solanaAddressFromPublicKey(derived.publicKey), KAT_SOLANA);

    for (let i = 0; i < 24; i++) {
      const random = core.randomBytes(64);
      for (const p of [core.SOLANA_DERIVATION_PATH, "m/44'/501'/1'/0'", "m/44'/501'/0'"]) {
        assert.equal(hex(core.slip10Ed25519(random, p)), derivePath(p, hex(random)).key.toString('hex'));
      }
    }
  });

  it('refuses non-hardened or malformed paths', () => {
    const seed = new Uint8Array(64);
    for (const p of ["m/44'/501'/0'/0", 'm', "44'/501'", "m/44'/501'/2147483648'"]) {
      assert.equal(code(() => core.slip10Ed25519(seed, p)), 'INVALID_PATH', p);
    }
  });

  it('signs a message and verifies it, and rejects foreign bytes', () => {
    const { privateKey, publicKey } = core.deriveSolanaKeypair(core.mnemonicToSeed(KAT_MNEMONIC));
    const message = utf8('solana transaction message bytes');
    const signature = core.signSolanaMessage(message, privateKey);
    assert.equal(signature.length, 64);
    assert.equal(core.verifySolanaSignature(signature, message, publicKey), true);
    assert.equal(core.verifySolanaSignature(signature, utf8('other'), publicKey), false);
    assert.equal(code(() => core.signSolanaMessage(message, privateKey.subarray(0, 31))), 'INVALID_LENGTH');
  });

  it('validates addresses and signatures canonically', () => {
    assert.equal(core.isValidSolanaAddress(KAT_SOLANA), true);
    assert.equal(core.isValidSolanaAddress(`${KAT_SOLANA}1`), false);
    assert.equal(core.isValidSolanaAddress('0OIl'.repeat(9)), false);
    assert.equal(core.isValidSolanaAddress(KAT_EON), false);
    const tx = fixture('devnet_burn_tx_nqh74h.json').result.transaction.signatures[0];
    assert.equal(core.isValidSolanaSignature(tx), true);
    assert.equal(core.isValidSolanaSignature(KAT_SOLANA), false);
  });

  it('derives the burn wallet associated token account seen on chain', () => {
    const burn = fixture('devnet_burn_tx_nqh74h.json').result;
    const info = burn.transaction.message.instructions.find((ix) => ix.parsed?.type === 'burn').parsed.info;
    assert.equal(core.associatedTokenAddress(info.authority, info.mint), info.account);
    assert.equal(core.isOnEd25519Curve(core.solanaAddressToBytes(info.authority)), true);
    assert.equal(core.isOnEd25519Curve(core.solanaAddressToBytes(info.account)), false);
    assert.equal(core.SOLANA_PROGRAMS.TOKEN, burn.transaction.message.instructions[0].programId);
    assert.equal(core.SOLANA_PROGRAMS.MEMO, burn.transaction.message.instructions[1].programId);
  });
});

describe('activation code', () => {
  // From the mobile implementation (WalletManager.generateActivationCodeLocally at 749281e, identical to
  // utils/activationCode.deriveActivationCode) run over these inputs.
  const VECTORS = [
    ['light', 'FVaaBjaHMKv2yneekLf7UtF7TAi4NpYHyDMrCfDtwBsR',
      'nqh74heddHDKQbzTqJAmu6o8VZEyBbdsfJcDJTtfPCYgTmGagX2xsrdZhkKFKBGFHyEq6tyNFrgZWrbTatq8Ywx', 1500,
      'QNET-LFEFD9-706058-537636'],
    ['super', 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk',
      '4j42Mx89ZsU8BPpsYULrye7q3iza85BW2ngsggYU75a2wQRc53BsEv3hQ3BBpLHZSQ5wH9nzuiYMtYJiHwfrZQaZ', 7500,
      'QNET-S5AD83-7B7305-0E042A'],
    ['Super', '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
      '4UHV6vWsKXVhTzxLdyX4MUiqp5AP7g8WdqvKtDe5K3zDx9G8qTDpu7D3GaDkXycNBsrELqxejBsE7RtMZFKyKSoy', 10000,
      'QNET-S27BFF-5C4137-5C66A4'],
    ['light', 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk',
      '53RUasV4Fz33fEKnNPsg8CqbVib9Z1pr9Tkbv6R7xQtWLA4yC8RDrv5UZLH9PpHmvLiSBSVAbtbDbt3d1uBdGmsy', 300,
      'QNET-L36863-7E2206-5E0202'],
  ];

  it('reproduces the mobile vectors, including the node-verified light KAT', () => {
    for (const [type, address, tx, amount, expected] of VECTORS) {
      assert.equal(core.generateActivationCode(type, address, tx, amount), expected);
      assert.equal(core.generateActivationCode(type, address, tx, String(amount)), expected);
      assert.equal(core.generateActivationCode(type, address, tx, BigInt(amount)), expected);
      assert.equal(core.activationCodeMatches(expected, type, address, tx, amount), true);
      assert.match(expected, core.ACTIVATION_CODE_RE);
    }
  });

  it('binds the code to the burn wallet, the transaction, the type and the amount', () => {
    const [, address, tx, amount, expected] = VECTORS[0];
    assert.equal(core.activationCodeMatches(expected, 'super', address, tx, amount), false);
    assert.equal(core.activationCodeMatches(expected, 'light', KAT_SOLANA, tx, amount), false);
    assert.equal(core.activationCodeMatches(expected, 'light', address, VECTORS[1][2], amount), false);
    assert.equal(core.activationCodeMatches(expected, 'light', address, tx, amount + 1), false);
  });

  it('refuses inputs the node could never verify', () => {
    const [, address, tx] = VECTORS[0];
    assert.equal(code(() => core.generateActivationCode('full', address, tx, 1500)), 'INVALID_NODE_TYPE');
    assert.equal(code(() => core.generateActivationCode('light', KAT_EON, tx, 1500)), 'INVALID_ADDRESS');
    assert.equal(code(() => core.generateActivationCode('light', address, 'not-a-signature', 1500)), 'INVALID_BURN_TX');
    for (const amount of [0, -1, 1500.5, '1500.0', '01500', 'NaN', 2 ** 64, null]) {
      assert.match(code(() => core.generateActivationCode('light', address, tx, amount)), /INVALID_(AMOUNT|INTEGER)/);
    }
  });

  it('gives a light burn aiqnet.io paid for a wallet the same format with the wallet\'s QNet address in it', () => {
    const [, burner, tx, amount] = VECTORS[0];
    // the format of generateActivationCode, written out once more over the wallet's address
    const sha3 = (text) => core.sha3_256Hex(new TextEncoder().encode(text));
    const key = sha3(`${tx}:light:${amount}`).slice(0, 32);
    const enc = Array.from(KAT_EON, (c, i) => (c.charCodeAt(0) ^ key.charCodeAt(i % 32)).toString(16).padStart(2, '0')).join('').toUpperCase();
    const expected = `QNET-L${sha3(`ts:${tx}:light`).slice(0, 5).toUpperCase()}-${enc.slice(0, 6)}-`
      + `${enc.slice(6, 10)}${sha3(`entropy:${KAT_EON}:${tx}:light`).slice(0, 2).toUpperCase()}`;
    const walletCode = core.walletActivationCode(KAT_EON, tx, amount);
    assert.equal(walletCode, expected);
    assert.match(walletCode, core.ACTIVATION_CODE_RE);
    assert.notEqual(walletCode, core.generateActivationCode('light', burner, tx, amount), 'not the payment key\'s code');
    assert.equal(core.activationCodeMatches(walletCode, 'light', burner, tx, amount), false);
    assert.equal(code(() => core.walletActivationCode(burner, tx, amount)), 'INVALID_ADDRESS');
    assert.equal(code(() => core.walletActivationCode(KAT_EON, 'not-a-signature', amount)), 'INVALID_BURN_TX');
    assert.match(code(() => core.walletActivationCode(KAT_EON, tx, 0)), /INVALID_(AMOUNT|INTEGER)/);
  });

  it('parses typed codes like mobile and rejects everything else', () => {
    assert.deepEqual(core.parseActivationCode(' qnet-lfefd9-706058-537636\n'),
      { code: 'QNET-LFEFD9-706058-537636', nodeType: 'light' });
    assert.equal(core.parseActivationCode('QNET-S5AD83-7B7305-0E042A').nodeType, 'super');
    for (const bad of ['QNET-XFEFD9-706058-537636', 'QNET-LFEFD9-706058-53763', 'QNET-BOOT-001-STRAP', '', 5]) {
      assert.equal(core.parseActivationCode(bad), null);
    }
  });
});

describe('QNet transfer signing', () => {
  const seed = core.mnemonicToSeed(KAT_MNEMONIC);
  const qnet = core.deriveQnetKeypair(seed);
  const { GAS_PRICE, TRANSFER_GAS_LIMIT } = core.fees;
  const tx = { from: KAT_EON, to: GENESIS_WALLET_001, amountNano: 1500000000, nonce: 1, gasPrice: GAS_PRICE, gasLimit: TRANSFER_GAS_LIMIT };

  it('signs the exact node preimage with ML-DSA-65 and the signature verifies there', async () => {
    const { preimage, signature } = core.signTransfer(tx, qnet.secretKey, qnet.publicKey);
    assert.equal(preimage, `q1337|transfer:${KAT_EON}:${GENESIS_WALLET_001}:1500000000:1:10:10000`);
    assert.equal(preimage, core.transferPreimage(KAT_EON, GENESIS_WALLET_001, 1500000000, 1, 10, 10000));
    assert.ok(preimage.startsWith(core.QNET_CHAIN_TAG));
    assert.ok(signature instanceof Uint8Array);
    assert.equal(signature.length, core.ML_DSA65.SIGNATURE_BYTES);
    assert.equal(core.verifyTransferSignature(tx, signature, qnet.publicKey), true);
    // What the node runs: pure ML-DSA-65, empty context, over the UTF-8 preimage.
    const pkHex = hex(qnet.publicKey);
    assert.equal(await core.verifyConsensusSignature(preimage, hex(signature), pkHex), true);
    const unbound = preimage.slice(core.QNET_CHAIN_TAG.length);
    assert.equal(await core.verifyConsensusSignature(unbound, hex(signature), pkHex), false);
  });

  it('binds every field', () => {
    const { signature } = core.signTransfer(tx, qnet.secretKey, qnet.publicKey);
    for (const change of [{ amountNano: 1500000001 }, { nonce: 2 }, { gasPrice: 11 }, { gasLimit: 10001 },
      { to: '02dca74ef2eae3be97feon499504db891ae0c60e364a8' }]) {
      assert.equal(core.verifyTransferSignature({ ...tx, ...change }, signature, qnet.publicKey), false);
    }
    const other = core.deriveQnetKeypair(core.mnemonicToSeed(`${'abandon '.repeat(23)}art`));
    assert.equal(core.verifyTransferSignature(tx, signature, other.publicKey), false);
  });

  it('refuses malformed transfers and a key that is not the sender', () => {
    const other = core.deriveQnetKeypair(core.mnemonicToSeed(`${'abandon '.repeat(23)}art`));
    assert.equal(code(() => core.signTransfer(tx, other.secretKey, other.publicKey)), 'KEY_ADDRESS_MISMATCH');
    assert.equal(code(() => core.signTransfer(tx, other.secretKey, qnet.publicKey)), 'SIGNATURE_SELF_CHECK_FAILED');
    assert.equal(code(() => core.signTransfer({ ...tx, to: 'd9fa370374e24333242eon847d1d354dcd87fe873823f' }, qnet.secretKey, qnet.publicKey)), 'INVALID_ADDRESS');
    for (const amountNano of ['1.5', 1.5, -1, '18446744073709551616', 2 ** 53, '1e9', '']) {
      assert.equal(code(() => core.signTransfer({ ...tx, amountNano }, qnet.secretKey, qnet.publicKey)), 'INVALID_INTEGER');
    }
    assert.equal(code(() => core.signTransfer({ ...tx, amountNano: 0 }, qnet.secretKey, qnet.publicKey)), 'INVALID_TRANSFER');
    assert.equal(code(() => core.signTransfer(tx, qnet.secretKey.subarray(1), qnet.publicKey)), 'INVALID_LENGTH');
    assert.equal(core.toU64String('18446744073709551615'), '18446744073709551615');
    assert.equal(core.toU64String(10n), '10');
  });

  it('accepts real EON addresses and rejects a broken checksum', () => {
    for (const entry of fixture('registry_height_2084400.json').entries) {
      assert.equal(core.isValidQnetAddress(entry.wallet), true, entry.wallet);
    }
    assert.equal(core.isValidQnetAddress(KAT_EON), true);
    assert.equal(core.isValidQnetAddress(KAT_EON.replace(/e$/, 'f')), false);
    assert.equal(core.isValidQnetAddress(KAT_EON.toUpperCase()), false);
    assert.equal(core.isValidQnetAddress(KAT_SOLANA), false);
  });
});

describe('light client transport (R2-EXTQ-05)', () => {
  it('reads macroblock proofs through a bounded fetch: https only, no credentials or redirects, no body over 16 MiB', async () => {
    const seen = [];
    const saved = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), init });
      return new Response('x'.repeat((16 << 20) + 1), { status: 200 });
    };
    try {
      core.clearQcCache();
      const height = (core.trustFloorIndex() + 1) * 90 + 5;
      assert.equal(await core.verifyMacroblockStateRoot('ab'.repeat(32), height, () => ['https://node1.aiqnet.io']), false);
      assert.ok(seen.length >= 1);
      for (const { url, init } of seen) {
        assert.match(url, /^https:\/\/node1\.aiqnet\.io\/api\/v1\/macroblock\//);
        assert.deepEqual([init.method, init.credentials, init.redirect, init.cache, init.referrerPolicy],
          ['GET', 'omit', 'error', 'no-store', 'no-referrer']);
      }
      seen.length = 0;
      core.clearQcCache();
      assert.equal(await core.verifyMacroblockStateRoot('ab'.repeat(32), height, () => [`http${''}://node1.aiqnet.io`]), false);
      assert.equal(seen.length, 0, 'plain HTTP is refused before any request');
    } finally {
      globalThis.fetch = saved;
      core.clearQcCache();
    }
  });

  // R4-EXTQ-03: a body without a usable length (chunked, compressed) is cut while it streams, never held whole.
  it('readBoundedText stops a body at the cap while it streams, whatever the headers say', async () => {
    let pulled = 0;
    const endless = new ReadableStream({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(64 * 1024).fill(0x61));
      },
    });
    await assert.rejects(core.readBoundedText(new Response(endless), 1 << 20), (e) => e.code === 'RESPONSE_TOO_LARGE');
    assert.ok(pulled <= 20, `read ${pulled} chunks of an endless body`);
    await assert.rejects(core.readBoundedText(new Response('x', { headers: { 'content-length': String(2 << 20) } }), 1 << 20),
      (e) => e.code === 'RESPONSE_TOO_LARGE');
    assert.equal(await core.readBoundedText(new Response('{"ok":true,"t":"ü"}'), 1 << 20), '{"ok":true,"t":"ü"}');
    assert.equal(await core.readBoundedText(new Response(null), 10), '');
  });
});

// The rule of both wallets, compiled from the app's source: at least 8 characters, nothing else (owner decision of
// 2026-09-28: the rule both wallets had before; no complexity, word or sequence checks).
describe('new vault passwords', () => {
  it('needs at least 8 characters, and checks nothing else', () => {
    assert.equal(core.PASSWORD_MIN_LENGTH, 8);
    for (const password of ['', 'seven77', '1234567', null, undefined, 12345678]) {
      assert.equal(core.passwordTooShort(password), true, String(password));
    }
    for (const password of [
      '12345678', 'password', 'aaaaaaaa', 'qwertyui', 'P@ssw0rd2024', 'Metallica123', 'ichliebedich', 'Здравствуйте',
      'correct horse battery staple', 'kx7#Qm2$vL9p', ' '.repeat(8), '🔑🔑🔑🔑',
    ]) {
      assert.equal(core.passwordTooShort(password), false, password);
    }
  });
});

describe('dApp message signing', () => {
  const origin = 'https://aiqnet.io';
  const qnet = core.deriveQnetKeypair(core.mnemonicToSeed(KAT_MNEMONIC));
  const decode = (bytes) => new TextDecoder().decode(bytes);

  it('wraps the message with the header, origin and UTF-8 byte length', () => {
    assert.equal(decode(core.buildOffchainMessage(origin, 'hello')), 'QNet Signed Message:\nhttps://aiqnet.io\n5\nhello');
    assert.equal(decode(core.buildOffchainMessage(origin, 'привет')), 'QNet Signed Message:\nhttps://aiqnet.io\n12\nпривет');
    const dev = cleartextOrigin('localhost:3000');
    assert.equal(decode(core.buildOffchainMessage(dev, 'a\nb\tc')), `QNet Signed Message:\n${dev}\n5\na\nb\tc`);
  });

  it('rejects every protocol prefix, in any case and after leading whitespace', () => {
    // every preimage family the node verifies against a wallet key, register: and migrate: included (XP-R3-05), the payment
    // key's owner bind and aiqnet.io's records of a wallet as the check folds them (decision 36)
    assert.deepEqual(core.PROTOCOL_PREFIXES,
      ['q1337|', 'qnet_register:', 'qnet_onchain_reg:', 'delegate_ping:', 'token_refresh:', 'ping:', 'selfattest:', 'register:', 'migrate:',
        'client_node_reg:', 'claim_rewards:', 'qnet_claim_v1:', 'qnet_dev_', 'qnet_burn_owner_v2:', 'qnetburnrecordv1',
        'qnetnodereservationv1']);
    for (const preimage of [`register:${KAT_EON}:QNET-L1B2C3-D4E5F6-G7H8I9:light`, 'migrate:QNET-L1B2C3-D4E5F6-G7H8I9:ab12',
      `qnet_dev_rebind:v1|1337|light_mobile_0123456789abcdef|light_mobile_fedcba9876543210|1790000000|${'A'.repeat(43)}`]) {
      assert.equal(code(() => core.buildOffchainMessage(origin, preimage)), 'PROTOCOL_PREFIX', preimage);
    }
    for (const prefix of core.PROTOCOL_PREFIXES) {
      for (const message of [`${prefix}x`, `  ${prefix.toUpperCase()}x`, `\n${prefix}`]) {
        assert.equal(core.hasProtocolPrefix(message), true);
        assert.equal(code(() => core.buildOffchainMessage(origin, message)), 'PROTOCOL_PREFIX', message);
      }
    }
    const transfer = core.transferPreimage(KAT_EON, GENESIS_WALLET_001, 1, 1, 10, 10000);
    assert.equal(code(() => core.signOffchainMessage(origin, transfer, qnet.secretKey, qnet.publicKey)), 'PROTOCOL_PREFIX');
    // aiqnet.io's records of a wallet and the payment key's owner bind, however a page writes them: never a dApp's message
    for (const message of ['QNet burn record v1\nwallet: x', 'QNet node reservation v1\nwallet: x', 'qnet burn record v1', 'QNETBURNRECORDV1',
      ' QNet  node reservation v1', 'qnet_burn_owner_v2:light_mobile_0:x', 'QNET_BURN_OWNER_V2:x']) {
      assert.equal(code(() => core.buildOffchainMessage(origin, message)), 'PROTOCOL_PREFIX', JSON.stringify(message));
    }
  });

  it('signs aiqnet.io\'s records of a wallet only through signSiteRecord, over the same envelope and context (decision 36)', () => {
    assert.deepEqual(core.SITE_RECORD_HEADS, ['QNet burn record v1\n', 'QNet node reservation v1\n']);
    const reservation = `QNet node reservation v1\nwallet: ${KAT_EON}\nnode: light\nway: payment\nburner: ${GENESIS_WALLET_001}\ntime: 1790000000\ncluster: devnet`;
    const record = `QNet burn record v1\nwallet: ${KAT_EON}\nnode: super\nburner: x\nburn: y\namount: 1500\ncluster: devnet`;
    for (const message of [reservation, record]) {
      const bytes = core.buildSiteRecord(origin, message);
      assert.equal(decode(bytes), `QNet Signed Message:\nhttps://aiqnet.io\n${new TextEncoder().encode(message).length}\n${message}`);
      const signed = core.signSiteRecord(origin, message, qnet.secretKey, qnet.publicKey);
      assert.deepEqual([signed.address, signed.signature.length], [KAT_EON, 3309]);
      assert.equal(core.verifySiteRecord(origin, message, signed.signature, qnet.publicKey), true);
      assert.equal(core.verifySiteRecord('https://evil.example', message, signed.signature, qnet.publicKey), false);
      assert.equal(core.verifySiteRecord(origin, `${message}0`, signed.signature, qnet.publicKey), false);
      // the dApp verifier never accepts it, and the dApp signer never makes it
      assert.equal(core.verifyOffchainMessage(origin, message, signed.signature, qnet.publicKey), false);
      assert.equal(code(() => core.signOffchainMessage(origin, message, qnet.secretKey, qnet.publicKey)), 'PROTOCOL_PREFIX');
    }
    // anything else is refused before a key is touched: a dApp's text, another record, a head written otherwise, the
    // protocol preimages, a hidden character, an oversized record, a bad origin
    for (const message of ['Hello', 'Sign in to aiqnet.io', 'qnet burn record v1\nwallet: x', 'QNet burn record v1', ' QNet burn record v1\nx',
      'QNet node reservation v2\nx', 'q1337|transfer:a:b:1:0:10:10000', `qnet_burn_owner_v2:light_mobile_0:${KAT_EON}`, '', null, 42]) {
      assert.equal(code(() => core.buildSiteRecord(origin, message)), 'INVALID_MESSAGE', JSON.stringify(message));
      assert.equal(code(() => core.signSiteRecord(origin, message, qnet.secretKey, qnet.publicKey)), 'INVALID_MESSAGE', JSON.stringify(message));
    }
    assert.equal(code(() => core.buildSiteRecord(origin, 'QNet burn record v1\nwallet: \u200bx')), 'INVALID_MESSAGE');
    assert.equal(code(() => core.buildSiteRecord(origin, `QNet burn record v1\n${'x'.repeat(4096)}`)), 'MESSAGE_TOO_LONG');
    assert.equal(code(() => core.buildSiteRecord('https://aiqnet.io/', reservation)), 'INVALID_ORIGIN');
  });

  it('rejects hidden controls, broken UTF-16, empty and oversized messages', () => {
    for (const message of ['', '‮evil', 'a⁦b', 'bell\u0007', 'nul\u0000', '\uD800', 'x\uDC00']) {
      assert.equal(code(() => core.buildOffchainMessage(origin, message)), 'INVALID_MESSAGE', JSON.stringify(message));
    }
  });

  it('rejects every character the approval would not show, and finds a prefix behind them (ES-04)', () => {
    const tags = [...'I approve'].map((c) => String.fromCodePoint(0xe0000 + c.codePointAt(0))).join('');
    const invisible = [
      'Sign in​', 'zero‌width', 'join‍', 'word⁠joiner', 'invisible⁢times', 'b﻿om',
      'soft­hyphen', 'cgj͏', 'mongolian᠎', 'khmer឴', 'hangulᅟ', 'hangulᅠ', 'hangulㅤ',
      'halfﾠwidth', 'braille⠀blank', 'line sep', 'para sep', 'heart❤️', 'vs\u{e0100}',
      `Sign in to aiqnet.io${tags}`, 'privateuse', 'unassigned͸', 'arabic؜mark', 'nel\u0085',
      'interlinear￹', 'mongolian fvs᠋',
    ];
    for (const message of invisible) {
      assert.equal(code(() => core.buildOffchainMessage(origin, message)), 'INVALID_MESSAGE', JSON.stringify(message));
    }
    for (const message of ['​q1337|transfer:1', 'q1337​|x', '­ping:1', 'q 1337|x', '　ping:x',
      'ｑ1337|x', 'q 1337 | x']) {
      assert.equal(core.hasProtocolPrefix(message), true, JSON.stringify(message));
    }
    assert.equal(code(() => core.buildOffchainMessage(origin, 'q 1337|x')), 'PROTOCOL_PREFIX');
    assert.equal(code(() => core.buildOffchainMessage(origin, '​q1337|transfer:1')), 'INVALID_MESSAGE');
    // R5-EXT-UI-01: a lone carriage return is drawn as nothing in the approval, but a verifier that splits lines on CR
    // reads a line break the user never saw; the narrow typographic spaces draw as a sliver
    for (const message of ['abc\rdef', 'Sign in\r\r\r\r\rnonce 42', 'Sign in to aiqnet.io\rrole: admin\nnonce: 7f3a', 'end\r',
      '\r\nstart\r', 'hair space', 'thin space', 'en quad', 'narrow nbsp', 'math space']) {
      assert.equal(code(() => core.buildOffchainMessage(origin, message)), 'INVALID_MESSAGE', JSON.stringify(message));
    }
    for (const message of ['Sign in to aiqnet.io 🎉', 'Привет, мир', '你好', 'مرحبا', 'tab\tand\nlines\r\n', 'keep ping: on',
      'crlf\r\nline\r\n\r\nend', 'no-break space', 'ideographic　space']) {
      assert.ok(core.buildOffchainMessage(origin, message).length > 0, JSON.stringify(message));
    }
    assert.equal(core.buildOffchainMessage(origin, 'x'.repeat(4096)).length > 4096, true);
    assert.equal(code(() => core.buildOffchainMessage(origin, 'x'.repeat(4097))), 'MESSAGE_TOO_LONG');
    assert.equal(code(() => core.buildOffchainMessage(origin, 'я'.repeat(2049))), 'MESSAGE_TOO_LONG');
  });

  it('accepts only serialized https (or loopback) origins', () => {
    for (const bad of ['https://aiqnet.io/', 'https://aiqnet.io/x', 'HTTPS://AIQNET.IO', 'javascript:alert(1)',
      'null', '', 'https://user@aiqnet.io', 'ftp://aiqnet.io', 'https://aiqnet.io\n']) {
      assert.equal(code(() => core.buildOffchainMessage(bad, 'hi')), 'INVALID_ORIGIN', bad);
    }
    assert.equal(code(() => core.buildOffchainMessage(cleartextOrigin('aiqnet.io'), 'hi')), 'INVALID_ORIGIN');
    assert.ok(core.buildOffchainMessage(cleartextOrigin('127.0.0.1:8080'), 'hi'));
  });

  it('round-trips, binds the origin, and can never pass as a transaction signature', async () => {
    const message = 'Sign in to aiqnet.io\nnonce: 42';
    const result = core.signOffchainMessage(origin, message, qnet.secretKey, qnet.publicKey);
    assert.equal(result.address, KAT_EON);
    assert.equal(result.signature.length, 3309);
    assert.equal(core.verifyOffchainMessage(origin, message, result.signature, qnet.publicKey), true);
    assert.equal(core.verifyOffchainMessage('https://evil.example', message, result.signature, qnet.publicKey), false);
    assert.equal(core.verifyOffchainMessage(origin, `${message}!`, result.signature, qnet.publicKey), false);
    // Empty-context verification (the node's) over the very bytes that were signed still fails.
    const signed = decode(core.buildOffchainMessage(origin, message));
    assert.equal(await core.verifyConsensusSignature(signed, hex(result.signature), hex(qnet.publicKey)), false);
    assert.equal(core.OFFCHAIN_MESSAGE_CONTEXT, 'QNET_OFFCHAIN_MSG_v1');
  });
});

describe('light client (compiled from the mobile source)', () => {
  it('verifies a live-captured macroblock QC with ML-DSA-65 against its certified anchor', async () => {
    const proof = fixture('macroblock_23162_proof.json');
    const anchor = fixture('macroblock_23160_proof.json');
    const registry = fixture('registry_height_2084400.json');
    const j = proof.index;
    const cp = proof.checkpoint;
    assert.equal(anchor.index, j - 2);
    assert.equal(Math.floor(cp.window_head_height / 90), j);

    const eligible = core.decodeEligibleNodeIds(hexToBytes(anchor.eligible_raw));
    const committee = core.sampleCommittee([...eligible].sort(), j, anchor.checkpoint.beacon);
    assert.deepEqual([...committee].sort(), [...proof.committee].sort());
    const quorum = core.checkpointQuorum(cp, committee);
    assert.equal(quorum, core.quorumSize(committee.length));
    const pubkeys = await core.resolvePubkeys(committee, anchor.checkpoint.registry_root, (j - 2) * 90,
      proof.committee_pubkeys, async () => registry, quorum);
    assert.ok(pubkeys, 'committee keys bind to the anchor registry root');

    const cpHash = core.checkpointHash(cp);
    const verifyAll = async (hash) => {
      const signers = new Set();
      for (let i = 0; i < proof.qc.signers.length; i++) {
        const signer = proof.qc.signers[i];
        const sig = core.parseDilithiumSig(proof.qc.sigs[i]);
        if (pubkeys[signer] && sig && await core.verifyConsensusSignature(`QNET_BFT2_VOTE:${hash}`, sig, pubkeys[signer])) {
          signers.add(signer);
        }
      }
      return signers.size;
    };
    assert.ok(await verifyAll(cpHash) >= quorum);
    assert.equal(core.epochCommitment(hexToBytes(proof.eligible_raw), committee, proof.banned), cp.epoch_commitment);

    const forged = core.checkpointHash({ ...cp, state_root: 'ff'.repeat(32) });
    assert.notEqual(forged, cpHash);
    assert.equal(await verifyAll(forged), 0);
    const foreignRoot = await core.resolvePubkeys(committee, 'ab'.repeat(32), (j - 2) * 90,
      proof.committee_pubkeys, async () => registry, quorum);
    assert.equal(foreignRoot, null);
  });

  it('keeps the Rust checkpoint hash vectors', () => {
    const KAT = {
      index: 4, parent_qc: { index: 3, checkpoint_hash: '02'.repeat(32) }, window_head_height: 120,
      window_mb_hashes: ['01'.repeat(32)], state_root: '03'.repeat(32), beacon: '04'.repeat(32),
      epoch_commitment: '05'.repeat(32), reward_root: '00'.repeat(32), registry_root: '00'.repeat(32),
      logs_root: '00'.repeat(32), dilithium_pk_root: '00'.repeat(32), reward_epoch_root: '00'.repeat(32),
      total_supply: 7, timestamp: 11, proposer: 'n1', recovery_anchor: null,
    };
    assert.equal(core.checkpointHash(KAT), '13fe6687b356572863ca25a3d0c225a30b904a03f5fed4a8574b22a80bf29be7');
    assert.equal(core.checkpointContentDigest(KAT), '5b9d0304967b92246400630f54df59d6ee2ae7388aa8cf0b7c25dd8d7360eba1');
    assert.equal(core.checkpointQuorum({ ...KAT, recovery_anchor: [2, '08'.repeat(32)] }, ['a', 'b', 'c']), null);
  });

  it('refuses to certify below the trust floor without touching the network', async () => {
    const offline = () => { throw new Error('must not fetch'); };
    assert.equal(await core.verifyMacroblockStateRoot('aa'.repeat(32), 10, offline), false);
    assert.equal(core.wsPinIsWellformed(), true);
  });

  it('folds the Rust account proof vector (mobile fixture)', () => {
    const v = mobileFixture('smt_account_proof.json');
    const account = { address: v.address, balance: v.balance, nonce: v.nonce };
    assert.equal(core.verifyAccountProof(account, v.proof, v.state_root), true);
    assert.equal(core.verifyAccountProof({ ...account, balance: String(Number(v.balance) + 1) }, v.proof, v.state_root), false);
    assert.equal(core.verifyAccountProof(account, v.proof, 'ff'.repeat(32)), false);
    assert.equal(core.verifyAccountProof(account, v.proof.slice(1), v.state_root), false);
  });
});

describe('token rules and the window\'s text rule', () => {
  it('flags a token named after QNet\'s coin in any spelling, and the address that destroys tokens (mobile tokenSafety)', () => {
    for (const [symbol, name] of [['QNC', 'x'], ['q n c', ''], ['GOLD', 'QNet Coin'], ['QΝC', ''], ['ＱＮＣ', '']]) {
      assert.equal(core.usesReservedName(symbol, name), true, `${symbol} ${name}`);
    }
    assert.equal(core.usesReservedName('GOLD', 'Gold Coin'), false);
    // the look-alikes the skeleton catches before and after NFKD: the lunate sigma (NFKD makes it Sigma), small
    // capitals, letterlike symbols, other scripts' letters and the boxed letters; an accent is dropped, whole or combining
    for (const [symbol, name] of [['QNϹ', ''], ['qnϲ', ''], ['QNᴄ', ''], ['ꞯɴᴄ', ''],
      ['', 'QNᴇᴛ'], ['QᶰC', ''], ['', 'QN℮T'], ['', 'QNℇT'], ['', 'qnεt'], ['զNC', ''],
      ['Qꓠꓚ', ''], ['QNᏟ', ''], ['QNⲤ', ''], ['', 'QNЄT'], ['\u{1F160}\u{1F15D}\u{1F152}', ''],
      ['\u{1F180}\u{1F17D}\u{1F172}', ''], ['\u{1F1F6}\u{1F1F3}\u{1F1E8}', ''],
      ['QNĊ', ''], ['QÑC', ''], ['QNĊ', ''], ['', 'QNÉT'], ['', 'QΝΈΤ']]) {
      assert.equal(core.usesReservedName(symbol, name), true, JSON.stringify([symbol, name]));
    }
    for (const [symbol, name] of [['ᴄᴏɪɴ', 'Small caps'], ['NEO', '℮-token'],
      ['\u{1F150}\u{1F151}\u{1F152}', 'x'], ['ΣΣ', 'Σigma'], ['CAFÉ', 'Café crème']]) {
      assert.equal(core.usesReservedName(symbol, name), false, JSON.stringify([symbol, name]));
    }
    assert.equal(core.destroysTokens(core.CANONICAL_BURN_ADDRESS), true);
    assert.equal(core.destroysTokens(core.KAT.qnetAddress), false);
  });

  // M-5: a direction override reorders what is drawn ("\u202eCNQ" reads as QNC, and so does "Q\u202eCN\u202c", which the
  // reversed text alone would not catch): a hidden or format character marks the token, and is shown as U+FFFD
  it('treats a hidden or format character in a symbol or name as QNet\'s name, and shows it as U+FFFD (mobile tokenSafety)', () => {
    for (const [symbol, name] of [['\u202eCNQ', ''], ['Q\u202eCN\u202c', ''], ['GOLD', 'Gold\u200bCoin'], ['G\u2066OLD', 'x'], ['GOLD', '\u00ad']]) {
      assert.equal(core.usesReservedName(symbol, name), true, JSON.stringify([symbol, name]));
    }
    assert.equal(core.tokenLabel('\u202eCNQ'), '\ufffdCNQ');
    assert.equal(core.tokenLabel('Q\u202eCN\u202c'), 'Q\ufffdCN\ufffd');
    assert.equal(core.tokenLabel('Gold Coin'), 'Gold Coin');
    assert.equal(core.tokenLabel('日本'), '日本');
    assert.equal(core.tokenLabel(7), '');
    for (const label of [core.tokenLabel('\u202eCNQ'), core.tokenLabel('a\u200bb\u2028c')]) assert.equal(core.isVisibleText(label), true, label);
    assert.equal(core.contractShortId(core.KAT.qnetAddress), `${core.KAT.qnetAddress.slice(0, 6)}\u2026${core.KAT.qnetAddress.slice(-4)}`);
  });

  it('isVisibleText is the signed-message rule: no hidden character, lone surrogate or lone carriage return', () => {
    for (const text of ['move e2e4', 'line\nline', 'crlf\r\n', 'tab\there', 'Ünïcödé 日本']) assert.equal(core.isVisibleText(text), true, JSON.stringify(text));
    for (const text of ['a​b', 'a‮b', 'a\rb', 'nul\u0000', '\ud800', 'a b', 7]) assert.equal(core.isVisibleText(text), false, JSON.stringify(text));
  });
});

describe('amounts (compiled from the mobile source)', () => {
  it('writes a figure as the language does, every digit kept, and passes any other text through', () => {
    assert.equal(core.amountText('2047243.4405', 'en'), '2,047,243.4405');
    assert.equal(core.amountText('2047243.4405', 'ru'), '2\u00a0047\u00a0243,4405');
    assert.equal(core.amountText('2047243.4405', 'de'), '2.047.243,4405');
    assert.equal(core.amountText('1234', 'es'), '1234');
    assert.equal(core.amountText('18446744073709551615', 'en'), '18,446,744,073,709,551,615');
    assert.equal(core.amountText('+0.000000001', 'fr'), '+0,000000001');
    for (const text of ['—', '1e+21', '.5']) assert.equal(core.amountText(text, 'en'), text);
  });

  it('reads a figure pasted in the language\'s format as written; typed text keeps the decimal comma', () => {
    assert.equal(core.amountInput('1,000', 9, { previous: '', lang: 'en' }), '1000');
    assert.equal(core.amountInput('1.000', 9, { previous: '', lang: 'de' }), '1000');
    assert.equal(core.amountInput('1,000', 9, { previous: '1,00', lang: 'en' }), '1.000');
    assert.equal(core.amountInput('1,000.5', 9), '1000.5');
    assert.equal(core.amountInput('1.2.3', 9), null);
  });
});

describe('bundle surface', () => {
  const EXPORTS = [
    // transactions (compiled from the mobile TxBuilders.js; test/tx-builders.test.mjs)
    'CANONICAL_BURN_ADDRESS', 'DEPLOY_BASE_GAS', 'DEPLOY_GAS_PER_BYTE', 'MAX_GAS_LIMIT', 'MAX_WASM_CODE_BYTES', 'TX_ROUTES',
    'WASM_DEFAULT_FUEL', 'WASM_MIN_FUEL', 'buildContractCall', 'buildContractDeploy', 'buildTokenTransfer', 'buildTransfer',
    'contractCallData', 'contractCallIntrinsicGas', 'contractCallPreimage', 'contractCallRequestJson', 'contractDeployData',
    'contractDeployIntrinsicGas', 'contractDeployPreimage', 'contractDeployRequestJson', 'deriveContractAddress',
    'signContractCall', 'signTokenTransfer', 'transferRequestJson', 'wasmCodeHash',
    // the token rules a token transfer's approval shows (compiled from the mobile utils/tokenSafety.js), and the text rule
    // of the approval window (message.js)
    'contractShortId', 'destroysTokens', 'tokenLabel', 'usesReservedName', 'isVisibleText',
    // amounts as the language writes them, and the amount field's reading of a typed or pasted figure (compiled from the
    // mobile utils/amountFormat.js and utils/sendAmount.js)
    'amountInput', 'amountText',
    // the light node messages (compiled from the mobile NodePreimages.js; test/light-node-vectors.test.mjs)
    'claimPayloadPreimage', 'claimQuotePreimage', 'consentPreimage', 'lightNodeId', 'ownerBindPreimage', 'publicKeySha3',
    'registrationProof',
    // the wallet's super node id, whose claim quote the builder above and the signer below also take (decision 47)
    'superNodeId',
    // and their signers: the node id and proof are the wallet's own, computed inside (node.js)
    'signClaimPayload', 'signClaimQuote', 'signNodeConsent', 'signNodeStatus', 'signOwnerBind', 'statusPreimage',
    // the wallet key's unbind of the node's device (decision 38)
    'signNodeUnbind', 'walletUnbindPreimage',
    // the code of a light burn aiqnet.io's payment key made for a wallet: the wallet's QNet address in the code
    'walletActivationCode',
    'ACTIVATION_CODE_RE', 'ACTIVATION_NODE_TYPES', 'CORE_VERSION', 'CoreError', 'KAT', 'ML_DSA65',
    'MNEMONIC_WORD_COUNTS', 'OFFCHAIN_MESSAGE_CONTEXT', 'OFFCHAIN_MESSAGE_HEADER', 'OFFCHAIN_MESSAGE_MAX_BYTES',
    'PASSWORD_MIN_LENGTH', 'PROTOCOL_PREFIXES', 'QNET_CHAIN_TAG', 'SITE_RECORD_HEADS', 'SOLANA_DERIVATION_PATH', 'SOLANA_PROGRAMS',
    'WALLET_SEED_PREFIX',
    'accountKeyHash', 'accountLeafHash', 'activationCodeMatches', 'argon2idAsync', 'assertBytes',
    'associatedTokenAddress', 'base58Decode', 'base58Encode', 'base64Decode', 'base64Encode', 'blake3',
    'buildOffchainMessage', 'buildSiteRecord', 'bytesToHex', 'canonicalizeMnemonic', 'chainIdentity', 'checkpointContentDigest', 'checkpointHash',
    'checkpointQuorum', 'clearQcCache', 'concatBytes', 'createProgramAddress', 'decodeEligibleNodeIds',
    'deriveQnetKeypair', 'deriveSolanaKeypair', 'entropyToMnemonic', 'entropyToSeed', 'eonFromPublicKeyBytes',
    'epochCommitment', 'equalBytes', 'exportVerifiedAnchors', 'fees', 'findProgramAddress', 'generateActivationCode',
    'generateEntropy', 'genesisConsensus', 'hasProtocolPrefix', 'hexToBytes', 'highestVerifiedIndex', 'hmac',
    'importVerifiedAnchors', 'isOnEd25519Curve', 'isValidQnetAddress', 'readBoundedText',
    'isValidSolanaAddress', 'isValidSolanaSignature', 'ltHashRowLanes', 'mnemonicToEntropy',
    'mnemonicToSeed', 'parseActivationCode', 'parseDilithiumSig', 'parseMnemonic', 'passwordTooShort', 'pbkdf2', 'pbkdf2Async',
    'qnetAddressFromPublicKey', 'quorumSize', 'randomBytes', 'recomputeRegistryRoot', 'resolvePubkeys', 'sampleCommittee',
    'selfTest', 'sha256', 'sha3_256', 'sha3_256Hex', 'sha512', 'shake256', 'signOffchainMessage', 'signSiteRecord', 'signSolanaMessage',
    'signTransfer', 'slip10Ed25519', 'smtFold', 'solanaAddressFromPublicKey', 'solanaAddressToBytes',
    'toU64String', 'transferLogLeaf', 'transferPreimage', 'trustFloorIndex', 'utf8Encode', 'validateMnemonic',
    'verifyAccountProof', 'verifyConsensusSignature', 'verifyLogInclusion', 'verifyLogWindowInclusion',
    'verifyMacroblockLogsRoot', 'verifyMacroblockStateRoot', 'verifyOffchainMessage', 'verifySiteRecord', 'verifySolanaSignature',
    'verifyTransferSignature', 'walletXi', 'wsPinIsWellformed', 'zeroize',
    // certified state proofs (proof_format 2): the shared verifier (mobile SmtFold.js), the light client's root of a named
    // macroblock and certified head, the old-node mark, and the strict reader of proof answers (mobile strictJson.js)
    'certifiedAccountLeafHash', 'certifiedHead', 'certifiedHeadHint', 'certifiedStateRootAt', 'certifiedStateRootIndex',
    'isLegacyProofBody', 'markNodeOld', 'nodeMarkedOld', 'parseStrictJson', 'readCertifiedAccount', 'readCertifiedToken',
    'storageKeyHash', 'storageLeafValue', 'u64Text', 'verifyAbsence', 'verifyAbsenceInBucket', 'verifyInclusion',
    'verifyLegacyTokenProof',
    // the GALC v2 capsule as a walk root, the follow tick, the walk's progress and the verified checkpoint fields
    // (mobile QcLightClient.js; docs/protocols/galc-capsule-v2.md)
    'capsulePreimage', 'clearCapsule', 'exportCapsule', 'followStep', 'heldCapsuleIndex', 'importCapsule', 'refreshCapsule',
    'stepsToVerify', 'verifiedCheckpoint',
  ];

  it('exports exactly the documented API, as a deep-frozen default namespace', () => {
    assert.deepEqual(Object.keys(core).filter((k) => k !== 'default').sort(), [...EXPORTS].sort());
    assert.deepEqual(Object.keys(QNetCore).sort(), [...EXPORTS].sort());
    for (const name of EXPORTS) assert.equal(QNetCore[name], core[name], name);
    assert.equal(Object.isFrozen(QNetCore), true);
    assert.equal(Object.getPrototypeOf(QNetCore), null);
    assert.throws(() => { QNetCore.signTransfer = () => null; }, TypeError);
    for (const value of [core.fees, core.genesisConsensus, core.genesisConsensus.GENESIS_CONSENSUS_PKS,
      core.genesisConsensus.WS_CHECKPOINT, core.PROTOCOL_PREFIXES, core.SITE_RECORD_HEADS, core.SOLANA_PROGRAMS, core.KAT,
      core.signTransfer, core.sha3_256]) {
      assert.equal(Object.isFrozen(value), true);
    }
    assert.throws(() => { core.genesisConsensus.GENESIS_CONSENSUS_PKS.genesis_node_001 = '00'; }, TypeError);
    assert.equal(core.CORE_VERSION, '3.1.0');
  });

  it('passes its own startup self-test', () => {
    assert.equal(core.selfTest(), true);
  });

  it('carries the chain fees compiled from mobile', () => {
    assert.equal(core.fees.GAS_PRICE, 10);
    assert.equal(core.fees.TRANSFER_GAS_LIMIT, 10000);
    assert.equal(core.fees.TRANSFER_FEE_NANO, 150000);
    assert.equal(core.fees.feeNano(10, 10000), 150000);
    assert.equal(core.fees.NANO_PER_QNC, 1e9);
  });

  it('exposes working primitives', async () => {
    assert.equal(hex(core.sha3_256(new Uint8Array())), 'a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a');
    assert.equal(hex(core.sha256(utf8('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal((await core.argon2idAsync(utf8('password'), utf8('somesalt'), { t: 1, m: 8, p: 1, dkLen: 32 })).length, 32);
    assert.equal(core.equalBytes(utf8('ab'), utf8('ab')), true);
    assert.equal(core.equalBytes(utf8('ab'), utf8('ac')), false);
    assert.equal(core.base58Encode(core.base58Decode(KAT_SOLANA)), KAT_SOLANA);
    assert.equal(code(() => core.hexToBytes('abc')), 'INVALID_HEX');
    const buffer = utf8('secret');
    core.zeroize(buffer);
    assert.deepEqual(buffer, new Uint8Array(6));
  });

  it('is one self-contained ESM file with no forbidden constructs', () => {
    const text = readFileSync(BUNDLE, 'utf8');
    assert.equal(text.charCodeAt(0) === 0xfeff, false);
    assert.equal(text.includes('\r'), false);
    for (const pattern of [/http:\/\//, /\beval\s*\(/, /new\s+Function\s*\(/, /innerHTML/, /document\.write/,
      /\bconsole\./, /\brequire\s*\(/, /(^|[;}\s])import\s*[{*"'(]/, /sourceMappingURL/]) {
      assert.doesNotMatch(text, pattern);
    }
  });
});
