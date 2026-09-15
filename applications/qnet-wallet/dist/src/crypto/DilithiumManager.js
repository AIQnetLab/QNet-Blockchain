/**
 * DilithiumManager — Dilithium-3 / ML-DSA-65 hybrid signing for QNet transactions.
 *
 * Purpose: provides the Dilithium half of the hybrid Ed25519 + Dilithium signature
 * that the client attaches to transactions. The Rust node's
 * `verify_dilithium_signature()` (quantum_crypto.rs) verifies this signature.
 *
 * Hybrid signing flow:
 *   1. Client signs tx data with Ed25519 (Solana wallet key)
 *   2. Client signs same tx data with Dilithium-3 (this module)
 *   3. Both signatures are included in the transaction payload
 *   4. Rust node verifies both independently (defense-in-depth)
 *
 * Wire format produced by signTransactionData():
 *   "dilithium_sig_{walletAddress}_{base64(payload)}"
 *   payload = [u32-LE: len(sig||msg)] [sig (3309)] [msg] [u32-LE: 1952] [pk (1952)]
 *   IDENTICAL to Android DilithiumModule.kt (putU32LE) and iOS DilithiumModule.m (writeU32LE).
 *
 * Algorithm: ML-DSA-65 (NIST FIPS 204 / Dilithium3)
 *   PK = 1952 bytes   SK = 4032 bytes   SIG = 3309 bytes (CTILDEBYTES=48)
 *   Same PQClean CLEAN implementation as Android JNI, iOS ObjC, and Rust pqcrypto_mldsa.
 *
 * Requires: noble-pq-ml-dsa.js loaded before this file (sets window.QNetDilithiumLib).
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const DILITHIUM_PUBLIC_KEY_SIZE = 1952;
const DILITHIUM_SECRET_KEY_SIZE = 4032;
const DILITHIUM_SIGNATURE_SIZE  = 3309;

// PBKDF2 — OWASP 2024 recommendation for AES-256 key derivation from password
const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_HASH       = 'SHA-256';
const AES_KEY_LENGTH    = 256;        // bits
const SALT_LENGTH       = 32;         // bytes
const IV_LENGTH         = 12;         // bytes (AES-GCM standard nonce)

// ─── DilithiumManager ────────────────────────────────────────────────────────

class DilithiumManager {
    constructor() {
        this._keypair  = null;           // { publicKey: Uint8Array(1952), secretKey: Uint8Array(4032) }
        this._storageKey = 'qnet_dilithium_keys_v1';
    }

    /**
     * Returns the QNetDilithium object from the noble bundle.
     * @throws if noble-pq-ml-dsa.js was not loaded.
     */
    _lib() {
        const lib = (typeof window !== 'undefined' ? window.QNetDilithiumLib : globalThis.QNetDilithiumLib);
        if (!lib || !lib.QNetDilithium) {
            throw new Error(
                '[FATAL][DILITHIUM] noble-pq-ml-dsa.js not loaded. ' +
                'Add <script src="lib/noble-pq-ml-dsa.js"> before DilithiumManager.js.'
            );
        }
        return lib.QNetDilithium;
    }

    // ─── Public API ──────────────────────────────────────────────────────────

    /**
     * Initialize: load existing keys from storage or generate a new keypair.
     * Must be called (with user password) before any signing operations.
     */
    async initialize(password) {
        if (!password || password.length < 8) {
            throw new Error('[ERR][DILITHIUM] password must be at least 8 characters');
        }
        const stored = await this._loadFromStorage(password);
        if (stored) {
            this._keypair = stored;
            console.log('[INFO][DILITHIUM] keys_loaded_from_storage');
        } else {
            await this.generateKeypair(password);
        }
    }

    /**
     * Generate a new random Dilithium-3 keypair, encrypt with password, persist.
     * Call only when user sets up a new wallet or explicitly rotates keys.
     */
    async generateKeypair(password) {
        const lib  = this._lib();
        const seed = new Uint8Array(32);
        crypto.getRandomValues(seed);

        const kp = lib.keygen(seed);
        seed.fill(0);

        if (kp.publicKey.length !== DILITHIUM_PUBLIC_KEY_SIZE) {
            throw new Error(`[ERR][DILITHIUM] unexpected pk size: ${kp.publicKey.length}`);
        }
        if (kp.secretKey.length !== DILITHIUM_SECRET_KEY_SIZE) {
            throw new Error(`[ERR][DILITHIUM] unexpected sk size: ${kp.secretKey.length}`);
        }

        this._keypair = {
            publicKey: new Uint8Array(kp.publicKey),
            secretKey: new Uint8Array(kp.secretKey),
        };

        await this._saveToStorage(this._keypair, password);
        console.log('[INFO][DILITHIUM] keypair_generated pk_size=' + this._keypair.publicKey.length);
    }

    /**
     * Sign transaction data and return a HybridSignatureResult ready to attach
     * to the transaction as `dilithium_signature` + `dilithium_public_key`.
     *
     * txData       — canonical transaction bytes or string (same bytes Ed25519 signs)
     * walletAddress — sender's QNet/Solana wallet address
     *
     * Returns { dilithiumSignature: string, dilithiumPublicKey: string, algorithm: string }
     *
     * The produced signature is verified by:
     *   QNetQuantumCrypto::verify_dilithium_signature() on the Rust node
     *   Android DilithiumModule.sign() — IDENTICAL wire format
     *   iOS DilithiumModule.sign()     — IDENTICAL wire format
     */
    async signTransactionData(txData, walletAddress) {
        if (!this._keypair) {
            throw new Error('[ERR][DILITHIUM] not initialized — call initialize(password) first');
        }

        const lib = this._lib();

        const msgBytes = typeof txData === 'string'
            ? new TextEncoder().encode(txData)
            : txData;

        // lib.sign() wraps PQCLEAN_DILITHIUM3_CLEAN_crypto_sign_signature()
        // → returns 3309-byte DETACHED signature (identical to Android nativeSign / iOS sign)
        const detachedSig = lib.sign(msgBytes, this._keypair.secretKey);

        if (detachedSig.length !== DILITHIUM_SIGNATURE_SIZE) {
            throw new Error(`[ERR][DILITHIUM] unexpected sig size: ${detachedSig.length}`);
        }

        // Construct SignedMessage = sig (3309) + msg — IDENTICAL to Android/iOS:
        //   Android: val signedMessage = sigBytes + messageBytes
        //   iOS:     memcpy(buf, sig, sigLen); memcpy(buf+sigLen, msgBytes, msgLen)
        const signedMessage = new Uint8Array(detachedSig.length + msgBytes.length);
        signedMessage.set(detachedSig, 0);
        signedMessage.set(msgBytes, detachedSig.length);

        // Build binary payload — IDENTICAL to Android putU32LE / iOS writeU32LE:
        //   [4 LE: len(sig||msg)] [sig||msg] [4 LE: len(pk)=1952] [pk]
        const pk      = this._keypair.publicKey;
        const payload = new Uint8Array(4 + signedMessage.length + 4 + pk.length);
        const view    = new DataView(payload.buffer);
        let   offset  = 0;

        view.setUint32(offset, signedMessage.length, true);  offset += 4;
        payload.set(signedMessage, offset);                   offset += signedMessage.length;
        view.setUint32(offset, pk.length, true);             offset += 4;
        payload.set(pk, offset);

        // base64 encode — same as Android Base64.NO_WRAP / iOS base64EncodedStringWithOptions:0
        const base64Payload = this._bytesToBase64(payload);
        const sigString     = `dilithium_sig_${walletAddress}_${base64Payload}`;

        console.log('[INFO][DILITHIUM] tx_signed wallet=' + walletAddress.substring(0, 8) + '...' +
            ' sig_len=' + detachedSig.length + ' msg_len=' + msgBytes.length);

        return {
            dilithiumSignature: sigString,
            dilithiumPublicKey: this._bytesToHex(pk),
            algorithm: 'CRYSTALS-Dilithium3',
        };
    }

    /**
     * Verify a Dilithium signature string produced by signTransactionData().
     * For client-side pre-validation before submitting the transaction.
     *
     * Returns true if the signature is valid.
     */
    async verifySignature(txData, sigString, pubKeyHex) {
        try {
            const lib = this._lib();

            const msgBytes = typeof txData === 'string'
                ? new TextEncoder().encode(txData)
                : txData;

            if (!sigString.startsWith('dilithium_sig_')) return false;

            // rfind('_') — same as Rust quantum_crypto.rs:583 signature.signature.rfind('_')
            // Standard base64 never contains underscores, so last '_' is always the separator.
            const lastUnderscore = sigString.lastIndexOf('_');
            if (lastUnderscore < 14) return false;

            const base64Part = sigString.slice(lastUnderscore + 1);
            let payloadBytes;
            try {
                payloadBytes = this._base64ToBytes(base64Part);
            } catch (_) {
                return false;
            }

            if (payloadBytes.length < 8) return false;

            const dv     = new DataView(payloadBytes.buffer);
            let   cursor = 0;

            const signedLen = dv.getUint32(cursor, true); cursor += 4;
            if (signedLen < DILITHIUM_SIGNATURE_SIZE || cursor + signedLen + 4 > payloadBytes.length) return false;

            const signedMessage = payloadBytes.slice(cursor, cursor + signedLen); cursor += signedLen;

            const pkLen = dv.getUint32(cursor, true); cursor += 4;
            if (pkLen !== DILITHIUM_PUBLIC_KEY_SIZE) return false;
            if (cursor + pkLen !== payloadBytes.length) return false;

            const pkFromPayload = payloadBytes.slice(cursor, cursor + pkLen);
            const pkToUse = pubKeyHex
                ? this._hexToBytes(pubKeyHex)
                : pkFromPayload;

            // Extract DETACHED signature = first 3309 bytes of SignedMessage
            // lib.verify() wraps PQCLEAN_DILITHIUM3_CLEAN_crypto_sign_verify(sig, 3309, msg, msgLen, pk)
            // IDENTICAL to Android nativeVerify / iOS PQCLEAN_DILITHIUM3_CLEAN_crypto_sign_verify
            const detachedSig = signedMessage.slice(0, DILITHIUM_SIGNATURE_SIZE);

            return lib.verify(msgBytes, detachedSig, pkToUse);
        } catch (_) {
            return false;
        }
    }

    /**
     * Hex-encoded Dilithium-3 public key (1952 bytes = 3904 hex chars).
     * Include in transaction as `dilithium_public_key`.
     * Returns null if not initialized.
     */
    getPublicKey() {
        return this._keypair ? this._bytesToHex(this._keypair.publicKey) : null;
    }

    /** Raw Dilithium-3 public key bytes. Returns null if not initialized. */
    getPublicKeyBytes() {
        return this._keypair ? this._keypair.publicKey.slice() : null;
    }

    /** Whether the manager has loaded keys and is ready to sign. */
    isReady() {
        return this._keypair !== null;
    }

    /**
     * Overwrite keys in memory with random bytes then null them.
     * Call on wallet lock / logout.
     */
    clearKeys() {
        if (this._keypair) {
            crypto.getRandomValues(this._keypair.secretKey);
            crypto.getRandomValues(this._keypair.publicKey);
            this._keypair = null;
        }
    }

    // ─── Key storage (IndexedDB) ─────────────────────────────────────────────

    async _saveToStorage(keypair, password) {
        const encrypted = await this._encryptKeys(keypair, password);
        const db        = await this._openDatabase();
        const tx        = db.transaction(['keys'], 'readwrite');
        const store     = tx.objectStore('keys');
        await new Promise((resolve, reject) => {
            const req = store.put({ id: this._storageKey, data: encrypted, ts: Date.now() });
            req.onsuccess = () => resolve();
            req.onerror   = () => reject(req.error);
        });
    }

    async _loadFromStorage(password) {
        try {
            const db    = await this._openDatabase();
            const tx    = db.transaction(['keys'], 'readonly');
            const store = tx.objectStore('keys');
            const record = await new Promise((resolve, reject) => {
                const req = store.get(this._storageKey);
                req.onsuccess = () => resolve(req.result);
                req.onerror   = () => reject(req.error);
            });
            if (!record) return null;
            return await this._decryptKeys(record.data, password);
        } catch (e) {
            console.log('[WARN][DILITHIUM] load_from_storage_failed err=' + e.message);
            return null;
        }
    }

    async _openDatabase() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('QNetWallet', 1);
            request.onerror         = () => reject(request.error);
            request.onsuccess       = () => resolve(request.result);
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('keys')) {
                    db.createObjectStore('keys', { keyPath: 'id' });
                }
            };
        });
    }

    // ─── Key encryption (AES-256-GCM + PBKDF2) ──────────────────────────────

    async _encryptKeys(keypair, password) {
        const salt   = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
        const iv     = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
        const encKey = await this._deriveKey(password, salt);

        const skBuffer  = keypair.secretKey.buffer.slice(
            keypair.secretKey.byteOffset,
            keypair.secretKey.byteOffset + keypair.secretKey.byteLength
        );
        const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encKey, skBuffer);

        return {
            salt:               Array.from(salt),
            iv:                 Array.from(iv),
            encryptedSecretKey: Array.from(new Uint8Array(encrypted)),
            publicKey:          Array.from(keypair.publicKey),
        };
    }

    async _decryptKeys(encrypted, password) {
        const salt   = new Uint8Array(encrypted.salt);
        const iv     = new Uint8Array(encrypted.iv);
        const encKey = await this._deriveKey(password, salt);

        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            encKey,
            new Uint8Array(encrypted.encryptedSecretKey),
        );

        return {
            publicKey: new Uint8Array(encrypted.publicKey),
            secretKey: new Uint8Array(decrypted),
        };
    }

    async _deriveKey(password, salt) {
        const saltBuffer = salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength);
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

    // ─── Helpers ─────────────────────────────────────────────────────────────

    _bytesToHex(bytes) {
        return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    _hexToBytes(hex) {
        if (hex.length % 2 !== 0) throw new Error('invalid hex length');
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        }
        return bytes;
    }

    _bytesToBase64(bytes) {
        // btoa() with chunk approach to avoid stack overflow on large arrays
        let binary = '';
        const CHUNK = 8192;
        for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
        }
        return btoa(binary);
    }

    _base64ToBytes(base64) {
        const binary = atob(base64);
        const bytes  = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

/** Global singleton — call dilithiumManager.initialize(password) before first use. */
const dilithiumManager = new DilithiumManager();
