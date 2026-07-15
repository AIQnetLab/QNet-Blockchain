/**
 * Bundle entry point for @noble/post-quantum ml_dsa65.
 * Exported as IIFE global: window.QNetDilithiumLib.QNetDilithium
 *
 * Algorithm: ML-DSA-65 (NIST FIPS 204)
 * Sizes: PK=1952, SK=4032, SIG=3309
 * Byte-compatible with:
 *   Android: PQClean ML-DSA-65 (CTILDEBYTES=48)
 *   iOS:     PQClean ML-DSA-65 (CTILDEBYTES=48)
 *   Rust:    pqcrypto_mldsa::mldsa65
 *
 * PURE DILITHIUM (F0.2): this bundle also owns the CANONICAL, cross-client wallet derivation +
 * transfer-signing so the extension JS cannot diverge from node/mobile. The derivation below is
 * KAT-proven against the golden vector (mnemonic "abandon…about" → eon
 * d9fa370374e24333242eon847d1d354dcd87fe873823e), byte-identical to the Rust node genesis_key.rs
 * and the mobile native path.
 */
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { shake256, sha3_256 } from '@noble/hashes/sha3.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';

const WALLET_SEED_PREFIX = 'QNET_WALLET_MLDSA65_v1:';

const utf8 = (s) => new TextEncoder().encode(s.normalize('NFKD'));
const rawUtf8 = (s) => new TextEncoder().encode(s);
const toHex = (u) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
// btoa on a large array without spread (avoids call-stack limits on ~7.4 KB buffers).
const bytesToB64 = (buf) => { let s = ''; for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]); return btoa(s); };

// Standard BIP39 seed: PBKDF2-HMAC-SHA512(mnemonic, "mnemonic"+passphrase, 2048, 64).
function bip39Seed(mnemonic, passphrase = '') {
  return pbkdf2(sha512, utf8(mnemonic), utf8('mnemonic' + passphrase), { c: 2048, dkLen: 64 });
}
// Canonical seed material ξ (xi): SHAKE256(WALLET_SEED_PREFIX + hex(bip39_seed))[..32].
function walletXi(mnemonic) {
  const seedString = WALLET_SEED_PREFIX + toHex(bip39Seed(mnemonic));
  return shake256(rawUtf8(seedString), { dkLen: 32 });
}
// EON address from an ML-DSA-65 public key: 19hex + "eon" + 15hex + 8-hex SHA3-256 checksum,
// over SHA512(pk). Matches solana_derivation::eon_from_qnet_dilithium_pubkey.
function formatEon(pkBytes) {
  const s512 = toHex(sha512(pkBytes));
  const part1 = s512.slice(0, 19);
  const part2 = s512.slice(19, 34);
  const checksum = toHex(sha3_256(rawUtf8(part1 + 'eon' + part2))).slice(0, 8);
  return part1 + 'eon' + part2 + checksum;
}

export const QNetDilithium = {
  /**
   * Generate an ML-DSA-65 keypair.
   * seed (optional): 32-byte Uint8Array for deterministic generation.
   * Returns { publicKey: Uint8Array(1952), secretKey: Uint8Array(4032) }
   */
  keygen(seed) {
    return ml_dsa65.keygen(seed);
  },

  /** Sign a message with ML-DSA-65. Returns a 3309-byte DETACHED signature. */
  sign(message, secretKey) {
    return ml_dsa65.sign(message, secretKey);
  },

  /** Verify a 3309-byte DETACHED ML-DSA-65 signature. Returns true if valid. */
  verify(message, signature, publicKey) {
    return ml_dsa65.verify(signature, message, publicKey);
  },

  /**
   * CANONICAL wallet derivation from a BIP39 mnemonic (pure ML-DSA-65, cross-client).
   * Returns { address (EON), publicKey (hex 1952B), secretKey (hex 4032B), xi (hex 32B) }.
   */
  deriveWallet(mnemonic) {
    const xi = walletXi(mnemonic);
    const kp = ml_dsa65.keygen(xi);
    return {
      address: formatEon(kp.publicKey),
      publicKey: toHex(kp.publicKey),
      secretKey: toHex(kp.secretKey),
      xi: toHex(xi),
    };
  },

  /** EON address from a raw ML-DSA-65 public key (hex string or Uint8Array). */
  addressFromPublicKey(pk) {
    return formatEon(pk instanceof Uint8Array ? pk : fromHex(pk));
  },

  /**
   * Sign a QNet canonical message and return the node wire format the value-TX gate expects:
   *   "dilithium_sig_{pk_hex}_{base64([sig_len:4LE][SignedMessage=sig||msg][pk_len:4LE][pk])}"
   * message: the exact canonical string (e.g. "transfer:{from}:{to}:{amount}:{nonce}:{gas_price}:{gas_limit}").
   */
  signQNet(message, secretKeyHex, publicKeyHex) {
    const sk = fromHex(secretKeyHex);
    const pk = fromHex(publicKeyHex);
    const msg = rawUtf8(message);
    const sig = ml_dsa65.sign(msg, sk); // 3309-byte detached
    const signedMsg = new Uint8Array(sig.length + msg.length);
    signedMsg.set(sig, 0);
    signedMsg.set(msg, sig.length);
    const buf = new Uint8Array(4 + signedMsg.length + 4 + pk.length);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, signedMsg.length, true);
    buf.set(signedMsg, 4);
    dv.setUint32(4 + signedMsg.length, pk.length, true);
    buf.set(pk, 4 + signedMsg.length + 4);
    return 'dilithium_sig_' + publicKeyHex + '_' + bytesToB64(buf);
  },

  PK_SIZE: 1952,
  SK_SIZE: 4032,
  SIG_SIZE: 3309,
};
