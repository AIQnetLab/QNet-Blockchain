/**
 * QNet Wallet Dilithium Key Manager
 * Handles quantum-resistant signatures for reward claims
 */

import { sha3_256 } from 'js-sha3';

// Dilithium-3 parameters (NIST Level 3)
const DILITHIUM_PUBLIC_KEY_SIZE = 1952;
const DILITHIUM_SECRET_KEY_SIZE = 4016;
const DILITHIUM_SIGNATURE_SIZE = 3293;

// PBKDF2 parameters — OWASP 2024 recommendation for AES-256 key derivation
const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_HASH = 'SHA-256';
const AES_KEY_LENGTH = 256;
const SALT_LENGTH = 32;

export interface DilithiumKeypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface RewardClaimData {
  nodeId: string;
  walletAddress: string;
  amount: bigint;
  timestamp: number;
}

export class DilithiumManager {
  private keypair: DilithiumKeypair | null = null;
  private storageKey = 'qnet_dilithium_keys';

  /**
   * Initialize Dilithium manager and load/generate keys.
   * password is required to decrypt existing keys or encrypt new ones.
   */
  async initialize(password: string): Promise<void> {
    if (!password || password.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }
    const stored = await this.loadFromStorage(password);
    if (stored) {
      this.keypair = stored;
    } else {
      await this.generateKeypair(password);
    }
  }

  /**
   * Generate new Dilithium-3 keypair and encrypt with user password.
   */
  async generateKeypair(password: string): Promise<void> {
    const seed = new Uint8Array(32);
    crypto.getRandomValues(seed);

    const dilithium = await this.loadDilithiumWasm();
    const keypair = dilithium.keypair_from_seed(seed);

    this.keypair = {
      publicKey: new Uint8Array(keypair.publicKey),
      secretKey: new Uint8Array(keypair.secretKey)
    };

    await this.saveToStorage(this.keypair, password);

    seed.fill(0);
  }

  /**
   * Generate deterministic keypair from activation code, encrypted with password.
   */
  async generateFromActivationCode(activationCode: string, password: string): Promise<void> {
    const encoder = new TextEncoder();
    const codeBytes = encoder.encode(activationCode);

    const hashHex = sha3_256(codeBytes);
    const seed = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      seed[i] = parseInt(hashHex.substr(i * 2, 2), 16);
    }

    const dilithium = await this.loadDilithiumWasm();
    const keypair = dilithium.keypair_from_seed(seed);

    this.keypair = {
      publicKey: new Uint8Array(keypair.publicKey),
      secretKey: new Uint8Array(keypair.secretKey)
    };

    await this.saveToStorage(this.keypair, password);

    seed.fill(0);
  }

  /**
   * Sign data for reward claim.
   */
  async signClaimRequest(data: RewardClaimData): Promise<string> {
    if (!this.keypair) {
      throw new Error('Dilithium keys not initialized');
    }

    const message = this.prepareClaimMessage(data);
    const dilithium = await this.loadDilithiumWasm();
    const signature = dilithium.sign(message, this.keypair.secretKey);

    return Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Prepare standardized message for signing.
   */
  private prepareClaimMessage(data: RewardClaimData): Uint8Array {
    const message = `claim_rewards:${data.nodeId}:${data.walletAddress}:${data.amount}:${data.timestamp}`;
    return new TextEncoder().encode(message);
  }

  /**
   * Get public key for registration.
   */
  getPublicKey(): string | null {
    if (!this.keypair) return null;
    return Array.from(this.keypair.publicKey)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Load Dilithium WASM module.
   */
  private async loadDilithiumWasm(): Promise<any> {
    if (typeof window !== 'undefined') {
      const module = await import('@qnet/dilithium-wasm');
      await module.default();
      return module;
    } else {
      const { createRequire } = await import('module');
      const require = createRequire(import.meta.url);
      return require('@qnet/dilithium-native');
    }
  }

  /**
   * Derive AES-GCM key from user password using PBKDF2.
   * salt must be stored alongside the encrypted data.
   */
  private async deriveKeyFromPassword(password: string, salt: Uint8Array): Promise<CryptoKey> {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    );

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: PBKDF2_ITERATIONS,
        hash: PBKDF2_HASH,
      },
      keyMaterial,
      { name: 'AES-GCM', length: AES_KEY_LENGTH },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Save keys to secure storage (IndexedDB), encrypted with user password.
   */
  private async saveToStorage(keypair: DilithiumKeypair, password: string): Promise<void> {
    if (typeof window !== 'undefined') {
      const encrypted = await this.encryptKeys(keypair, password);
      const db = await this.openDatabase();
      const tx = db.transaction(['keys'], 'readwrite');
      const store = tx.objectStore('keys');

      await new Promise<void>((resolve, reject) => {
        const req = store.put({
          id: this.storageKey,
          data: encrypted,
          timestamp: Date.now()
        });
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } else {
      const fs = await import('fs/promises');
      const path = await import('path');
      const os = await import('os');

      const keyPath = path.join(os.homedir(), '.qnet', 'dilithium.key');
      const encrypted = await this.encryptKeys(keypair, password);

      await fs.mkdir(path.dirname(keyPath), { recursive: true });
      await fs.writeFile(keyPath, JSON.stringify(encrypted), 'utf8');
    }
  }

  /**
   * Load keys from secure storage, decrypt with user password.
   */
  private async loadFromStorage(password: string): Promise<DilithiumKeypair | null> {
    try {
      if (typeof window !== 'undefined') {
        const db = await this.openDatabase();
        const tx = db.transaction(['keys'], 'readonly');
        const store = tx.objectStore('keys');

        const record = await new Promise<any>((resolve, reject) => {
          const req = store.get(this.storageKey);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        if (!record) return null;

        return await this.decryptKeys(record.data, password);
      } else {
        const fs = await import('fs/promises');
        const path = await import('path');
        const os = await import('os');

        const keyPath = path.join(os.homedir(), '.qnet', 'dilithium.key');
        const data = await fs.readFile(keyPath, 'utf8');
        const encrypted = JSON.parse(data);

        return await this.decryptKeys(encrypted, password);
      }
    } catch {
      return null;
    }
  }

  /**
   * Open IndexedDB database.
   */
  private async openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('QNetWallet', 1);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('keys')) {
          db.createObjectStore('keys', { keyPath: 'id' });
        }
      };
    });
  }

  /**
   * Encrypt keys with AES-GCM-256 using PBKDF2-derived key.
   * Stores salt + iv alongside encrypted data.
   */
  private async encryptKeys(keypair: DilithiumKeypair, password: string): Promise<any> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const encKey = await this.deriveKeyFromPassword(password, salt);

    // Only encrypt the secret key — public key is not sensitive
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      encKey,
      keypair.secretKey
    );

    return {
      salt: Array.from(salt),
      iv: Array.from(iv),
      encryptedSecretKey: Array.from(new Uint8Array(encrypted)),
      publicKey: Array.from(keypair.publicKey),
    };
  }

  /**
   * Decrypt keys from storage using PBKDF2-derived key.
   */
  private async decryptKeys(encrypted: any, password: string): Promise<DilithiumKeypair> {
    const salt = new Uint8Array(encrypted.salt);
    const iv = new Uint8Array(encrypted.iv);

    const encKey = await this.deriveKeyFromPassword(password, salt);

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      encKey,
      new Uint8Array(encrypted.encryptedSecretKey)
    );

    return {
      publicKey: new Uint8Array(encrypted.publicKey),
      secretKey: new Uint8Array(decrypted),
    };
  }

  /**
   * Clear keys from memory securely.
   */
  clearKeys(): void {
    if (this.keypair) {
      crypto.getRandomValues(this.keypair.secretKey);
      crypto.getRandomValues(this.keypair.publicKey);
      this.keypair = null;
    }
  }
}

// Export singleton instance (password must be passed to initialize())
export const dilithiumManager = new DilithiumManager();
