/// <reference path="./vendor.d.ts" />

/**
 * QNet Wallet — Dilithium-3 Key Manager (TypeScript source)
 *
 * Purpose: provides the Dilithium half of the hybrid Ed25519 + Dilithium
 * signature that the client attaches to transactions. The Rust node's
 * `verify_dilithium_signature()` (quantum_crypto.rs) verifies this signature.
 *
 * Hybrid signing flow:
 *   1. Client signs tx data with Ed25519 (Solana wallet key)
 *   2. Client signs same tx data with Dilithium-3 (this module)
 *   3. Both signatures are included in the transaction payload
 *   4. Rust node verifies both independently (defense-in-depth)
 *
 * Wire format produced by signTransactionData() — IDENTICAL to Android/iOS:
 *   "dilithium_sig_{walletAddress}_{base64(payload)}"
 *   payload = [u32-LE: len(sig||msg)] [sig (3309)] [msg] [u32-LE: 1952] [pk (1952)]
 *   Matches Android DilithiumModule.kt (putU32LE) and iOS DilithiumModule.m (writeU32LE).
 *
 * Algorithm: ML-DSA-65 (NIST FIPS 204)
 *   PK = 1952 bytes   SK = 4032 bytes   SIG = 3309 bytes (CTILDEBYTES=48)
 *   Same PQClean CLEAN implementation as Android JNI, iOS ObjC, and Rust pqcrypto_mldsa.
 *
 * Dependency: @noble/post-quantum — pure-JS ML-DSA-65, MIT, audited.
 *   npm install @noble/post-quantum
 *   For the browser extension, use the pre-built IIFE in dist/lib/noble-pq-ml-dsa.js.
 */

import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';

// ─── Constants ────────────────────────────────────────────────────────────────

// ML-DSA-65 / Dilithium3 parameters (NIST FIPS 204, CTILDEBYTES=48)
// PK=1952, SK=4032, SIG=3309 — identical to Android JNI and iOS ObjC
const DILITHIUM_PUBLIC_KEY_SIZE = 1952;
const DILITHIUM_SECRET_KEY_SIZE = 4032;
const DILITHIUM_SIGNATURE_SIZE  = 3309;

// PBKDF2 — OWASP 2024 recommendation for AES-256 key derivation
const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_HASH       = 'SHA-256';
const AES_KEY_LENGTH    = 256;
const SALT_LENGTH       = 32;

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface DilithiumKeypair {
  publicKey: Uint8Array;  // 1952 bytes
  secretKey: Uint8Array;  // 4032 bytes
}

/** Result of hybrid signing — attach both fields to the transaction payload */
export interface HybridSignatureResult {
  /** Dilithium-3 signature string for the `dilithium_signature` tx field */
  dilithiumSignature: string;
  /** Hex-encoded Dilithium-3 public key for the `dilithium_public_key` tx field */
  dilithiumPublicKey: string;
  /** Algorithm name expected by the Rust node (must be exactly this string) */
  algorithm: 'CRYSTALS-Dilithium3';
}

// ─── DilithiumManager ─────────────────────────────────────────────────────────

export class DilithiumManager {
  private keypair: DilithiumKeypair | null = null;
  private readonly storageKey = 'qnet_dilithium_keys_v1';

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Initialize: load existing keys from storage or generate a new keypair.
   * Must be called (with user password) before any signing operations.
   */
  async initialize(password: string): Promise<void> {
    if (!password || password.length < 8) {
      throw new Error('[ERR][DILITHIUM] password must be at least 8 characters');
    }
    const stored = await this.loadFromStorage(password);
    if (stored) {
      this.keypair = stored;
    } else {
      await this.generateKeypair(password);
    }
  }

  /**
   * Generate a new random Dilithium-3 keypair, encrypt with password, persist.
   * Call only when the user sets up a new wallet or explicitly rotates keys.
   */
  async generateKeypair(password: string): Promise<void> {
    const seed = new Uint8Array(32);
    crypto.getRandomValues(seed);

    // ml_dsa65.keygen(seed) — deterministic from seed; same PQClean CLEAN C under the hood
    const kp = ml_dsa65.keygen(seed);
    seed.fill(0);

    this.keypair = {
      publicKey: new Uint8Array(kp.publicKey),
      secretKey: new Uint8Array(kp.secretKey),
    };

    if (this.keypair.publicKey.length !== DILITHIUM_PUBLIC_KEY_SIZE) {
      this.keypair = null;
      throw new Error(`[ERR][DILITHIUM] unexpected pk size: ${kp.publicKey.length} (expected ${DILITHIUM_PUBLIC_KEY_SIZE})`);
    }
    if (this.keypair.secretKey.length !== DILITHIUM_SECRET_KEY_SIZE) {
      this.keypair = null;
      throw new Error(`[ERR][DILITHIUM] unexpected sk size: ${kp.secretKey.length} (expected ${DILITHIUM_SECRET_KEY_SIZE})`);
    }

    await this.saveToStorage(this.keypair, password);
  }

  /**
   * Sign transaction data and return a HybridSignatureResult ready to attach
   * to the transaction as `dilithium_signature` + `dilithium_public_key`.
   *
   * `txData`        — canonical transaction bytes (same bytes Ed25519 signs)
   * `walletAddress` — sender's QNet/Solana wallet address
   *
   * The produced signature is verified by:
   *   QNetQuantumCrypto::verify_dilithium_signature() on the Rust node
   *   Android DilithiumModule.sign() — IDENTICAL wire format
   *   iOS DilithiumModule.sign()     — IDENTICAL wire format
   */
  async signTransactionData(
    txData: Uint8Array | string,
    walletAddress: string,
  ): Promise<HybridSignatureResult> {
    if (!this.keypair) {
      throw new Error('[ERR][DILITHIUM] not initialized — call initialize(password) first');
    }

    const msgBytes: Uint8Array = typeof txData === 'string'
      ? new TextEncoder().encode(txData)
      : txData;

    // ml_dsa65.sign(msg, sk) wraps PQCLEAN_DILITHIUM3_CLEAN_crypto_sign_signature()
    // → returns 3309-byte DETACHED signature (identical to Android nativeSign / iOS sign)
    const detachedSig: Uint8Array = ml_dsa65.sign(msgBytes, this.keypair.secretKey);

    if (detachedSig.length !== DILITHIUM_SIGNATURE_SIZE) {
      throw new Error(
        `[ERR][DILITHIUM] unexpected detached sig length: ${detachedSig.length} ` +
        `(expected ${DILITHIUM_SIGNATURE_SIZE})`
      );
    }

    // Construct SignedMessage = sig (3309) + msg — IDENTICAL to Android/iOS:
    //   Android: val signedMessage = sigBytes + messageBytes
    //   iOS:     memcpy(buf, sig, sigLen); memcpy(buf+sigLen, msgBytes, msgLen)
    const signedMessage = new Uint8Array(detachedSig.length + msgBytes.length);
    signedMessage.set(detachedSig, 0);
    signedMessage.set(msgBytes, detachedSig.length);

    // Build binary payload — IDENTICAL to Android putU32LE / iOS writeU32LE:
    //   [4 LE: len(sig||msg)] [sig||msg] [4 LE: len(pk)=1952] [pk]
    const pk = this.keypair.publicKey;
    const payload = new Uint8Array(4 + signedMessage.length + 4 + pk.length);
    const view = new DataView(payload.buffer);
    let offset = 0;

    view.setUint32(offset, signedMessage.length, true);  offset += 4;
    payload.set(signedMessage, offset);                   offset += signedMessage.length;
    view.setUint32(offset, pk.length, true);             offset += 4;
    payload.set(pk, offset);

    // base64 encode — same as Android Base64.NO_WRAP / iOS base64EncodedStringWithOptions:0
    const base64Payload = this.bytesToBase64(payload);
    const sigString = `dilithium_sig_${walletAddress}_${base64Payload}`;

    return {
      dilithiumSignature: sigString,
      dilithiumPublicKey: this.bytesToHex(pk),
      algorithm: 'CRYSTALS-Dilithium3',
    };
  }

  /**
   * Verify a Dilithium signature string produced by signTransactionData().
   * For client-side pre-validation before submitting the transaction.
   */
  async verifySignature(
    txData: Uint8Array | string,
    sigString: string,
    pubKeyHex?: string,
  ): Promise<boolean> {
    try {
      const msgBytes: Uint8Array = typeof txData === 'string'
        ? new TextEncoder().encode(txData)
        : txData;

      if (!sigString.startsWith('dilithium_sig_')) return false;

      // rfind('_') — same as Rust quantum_crypto.rs:583 signature.signature.rfind('_')
      // Standard base64 has no underscores, so lastIndexOf is always the separator.
      const lastUnderscore = sigString.lastIndexOf('_');
      if (lastUnderscore < 14) return false;

      const base64Part = sigString.slice(lastUnderscore + 1);
      const payloadBytes = this.base64ToBytes(base64Part);
      if (payloadBytes.length < 8) return false;

      const dv = new DataView(payloadBytes.buffer);
      let cursor = 0;

      const signedLen = dv.getUint32(cursor, true); cursor += 4;
      if (signedLen < DILITHIUM_SIGNATURE_SIZE || cursor + signedLen + 4 > payloadBytes.length) return false;

      const signedMessage = payloadBytes.slice(cursor, cursor + signedLen); cursor += signedLen;

      const pkLen = dv.getUint32(cursor, true); cursor += 4;
      if (pkLen !== DILITHIUM_PUBLIC_KEY_SIZE) return false;
      if (cursor + pkLen !== payloadBytes.length) return false;

      const pkFromPayload = payloadBytes.slice(cursor, cursor + pkLen);
      const pkToUse = pubKeyHex
        ? this.hexToBytes(pubKeyHex)
        : pkFromPayload;

      // Extract DETACHED sig = first 3309 bytes of SignedMessage
      // ml_dsa65.verify(sig, msg, pk) wraps PQCLEAN_DILITHIUM3_CLEAN_crypto_sign_verify
      // IDENTICAL to Android nativeVerify / iOS PQCLEAN_DILITHIUM3_CLEAN_crypto_sign_verify
      const detachedSig = signedMessage.slice(0, DILITHIUM_SIGNATURE_SIZE);

      return ml_dsa65.verify(detachedSig, msgBytes, pkToUse);
    } catch {
      return false;
    }
  }

  /**
   * Hex-encoded Dilithium-3 public key (1952 bytes = 3904 hex chars).
   * Include in transaction as `dilithium_public_key`.
   * Returns null if not initialized.
   */
  getPublicKey(): string | null {
    return this.keypair ? this.bytesToHex(this.keypair.publicKey) : null;
  }

  /** Raw Dilithium-3 public key bytes. Returns null if not initialized. */
  getPublicKeyBytes(): Uint8Array | null {
    return this.keypair ? this.keypair.publicKey.slice() : null;
  }

  /** Whether the manager has loaded keys and is ready to sign. */
  isReady(): boolean {
    return this.keypair !== null;
  }

  /**
   * Overwrite keys in memory with random bytes then null them.
   * Call on wallet lock / logout.
   */
  clearKeys(): void {
    if (this.keypair) {
      crypto.getRandomValues(this.keypair.secretKey);
      crypto.getRandomValues(this.keypair.publicKey);
      this.keypair = null;
    }
  }

  // ─── Key storage ───────────────────────────────────────────────────────────

  private async saveToStorage(keypair: DilithiumKeypair, password: string): Promise<void> {
    const encrypted = await this.encryptKeys(keypair, password);
    if (typeof window !== 'undefined') {
      const db = await this.openDatabase();
      const tx = db.transaction(['keys'], 'readwrite');
      const store = tx.objectStore('keys');
      await new Promise<void>((resolve, reject) => {
        const req = store.put({ id: this.storageKey, data: encrypted, ts: Date.now() });
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
      });
    } else {
      const fs   = await import('fs/promises');
      const path = await import('path');
      const os   = await import('os');
      const keyPath = path.join(os.homedir(), '.qnet', 'dilithium.key');
      await fs.mkdir(path.dirname(keyPath), { recursive: true });
      await fs.writeFile(keyPath, JSON.stringify(encrypted), 'utf8');
    }
  }

  private async loadFromStorage(password: string): Promise<DilithiumKeypair | null> {
    try {
      let encrypted: unknown;
      if (typeof window !== 'undefined') {
        const db    = await this.openDatabase();
        const tx    = db.transaction(['keys'], 'readonly');
        const store = tx.objectStore('keys');
        const record = await new Promise<{data: unknown} | undefined>((resolve, reject) => {
          const req = store.get(this.storageKey);
          req.onsuccess = () => resolve(req.result as {data: unknown} | undefined);
          req.onerror   = () => reject(req.error);
        });
        if (!record) return null;
        encrypted = record.data;
      } else {
        const fs   = await import('fs/promises');
        const path = await import('path');
        const os   = await import('os');
        const keyPath = path.join(os.homedir(), '.qnet', 'dilithium.key');
        encrypted = JSON.parse(await fs.readFile(keyPath, 'utf8'));
      }
      return await this.decryptKeys(encrypted, password);
    } catch {
      return null;
    }
  }

  private async openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('QNetWallet', 1);
      request.onerror         = () => reject(request.error);
      request.onsuccess       = () => resolve(request.result);
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('keys')) {
          db.createObjectStore('keys', { keyPath: 'id' });
        }
      };
    });
  }

  // ─── Key encryption (AES-256-GCM + PBKDF2) ─────────────────────────────────

  private async encryptKeys(keypair: DilithiumKeypair, password: string): Promise<unknown> {
    const salt   = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const iv     = crypto.getRandomValues(new Uint8Array(12));
    const encKey = await this.deriveKey(password, salt);

    const skBuffer = this.toArrayBuffer(keypair.secretKey);
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encKey, skBuffer);

    return {
      salt:               Array.from(salt),
      iv:                 Array.from(iv),
      encryptedSecretKey: Array.from(new Uint8Array(encrypted)),
      publicKey:          Array.from(keypair.publicKey),
    };
  }

  private async decryptKeys(encrypted: unknown, password: string): Promise<DilithiumKeypair> {
    const enc    = encrypted as {salt: number[]; iv: number[]; encryptedSecretKey: number[]; publicKey: number[]};
    const salt   = new Uint8Array(enc.salt);
    const iv     = new Uint8Array(enc.iv);
    const encKey = await this.deriveKey(password, salt);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      encKey,
      new Uint8Array(enc.encryptedSecretKey),
    );
    return {
      publicKey: new Uint8Array(enc.publicKey),
      secretKey: new Uint8Array(decrypted),
    };
  }

  private async deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
    const saltBuffer = this.toArrayBuffer(salt);
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    return crypto.subtle.deriveKey(
      {
        name:       'PBKDF2',
        salt:       saltBuffer,
        iterations: PBKDF2_ITERATIONS,
        hash:       PBKDF2_HASH,
      },
      keyMaterial,
      { name: 'AES-GCM', length: AES_KEY_LENGTH },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** Copy a Uint8Array into a plain ArrayBuffer (Web Crypto rejects SharedArrayBuffer). */
  private toArrayBuffer(arr: Uint8Array): ArrayBuffer {
    return arr.buffer instanceof ArrayBuffer && arr.byteOffset === 0 && arr.byteLength === arr.buffer.byteLength
      ? arr.buffer
      : arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;
  }

  private bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  private hexToBytes(hex: string): Uint8Array {
    if (hex.length % 2 !== 0) throw new Error('invalid hex length');
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  private bytesToBase64(bytes: Uint8Array): string {
    // Chunked approach to avoid stack overflow on large Uint8Arrays
    let binary = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  private base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
}

/** Singleton — call `dilithiumManager.initialize(password)` before first use. */
export const dilithiumManager = new DilithiumManager();
