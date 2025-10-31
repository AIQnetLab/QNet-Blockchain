/**
 * QNet Wallet Dilithium Key Manager
 * Handles quantum-resistant signatures for reward claims
 */

import { sha3_256 } from 'js-sha3';

// Dilithium-3 parameters (NIST Level 3)
const DILITHIUM_PUBLIC_KEY_SIZE = 1952;
const DILITHIUM_SECRET_KEY_SIZE = 4016;
const DILITHIUM_SIGNATURE_SIZE = 3293;

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
   * Initialize Dilithium manager and load/generate keys
   */
  async initialize(): Promise<void> {
    // Try to load existing keys
    const stored = await this.loadFromStorage();
    if (stored) {
      this.keypair = stored;
      console.log('✅ Loaded existing Dilithium keys');
    } else {
      // Generate new keypair
      await this.generateKeypair();
      console.log('🔑 Generated new Dilithium keypair');
    }
  }

  /**
   * Generate new Dilithium-3 keypair
   */
  async generateKeypair(): Promise<void> {
    // Use Web Crypto API for secure random
    const seed = new Uint8Array(32);
    crypto.getRandomValues(seed);

    // Import dilithium-wasm for browser
    const dilithium = await this.loadDilithiumWasm();
    
    const keypair = dilithium.keypair_from_seed(seed);
    this.keypair = {
      publicKey: new Uint8Array(keypair.publicKey),
      secretKey: new Uint8Array(keypair.secretKey)
    };

    // Save to secure storage
    await this.saveToStorage(this.keypair);

    // Clear sensitive data
    seed.fill(0);
  }

  /**
   * Generate deterministic keypair from activation code
   */
  async generateFromActivationCode(activationCode: string): Promise<void> {
    // Create deterministic seed from activation code
    const encoder = new TextEncoder();
    const codeBytes = encoder.encode(activationCode);
    
    // Use SHA3-256 to derive seed
    const hashHex = sha3_256(codeBytes);
    const seed = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      seed[i] = parseInt(hashHex.substr(i * 2, 2), 16);
    }

    // Generate keypair from seed
    const dilithium = await this.loadDilithiumWasm();
    const keypair = dilithium.keypair_from_seed(seed);
    
    this.keypair = {
      publicKey: new Uint8Array(keypair.publicKey),
      secretKey: new Uint8Array(keypair.secretKey)
    };

    await this.saveToStorage(this.keypair);
    
    // Clear sensitive data
    seed.fill(0);
  }

  /**
   * Sign data for reward claim
   */
  async signClaimRequest(data: RewardClaimData): Promise<string> {
    if (!this.keypair) {
      throw new Error('Dilithium keys not initialized');
    }

    // Prepare message to sign
    const message = this.prepareClaimMessage(data);
    
    // Sign with Dilithium
    const dilithium = await this.loadDilithiumWasm();
    const signature = dilithium.sign(message, this.keypair.secretKey);
    
    // Convert to hex string for API
    return Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Prepare standardized message for signing
   */
  private prepareClaimMessage(data: RewardClaimData): Uint8Array {
    // Create canonical message format
    const message = `claim_rewards:${data.nodeId}:${data.walletAddress}:${data.amount}:${data.timestamp}`;
    return new TextEncoder().encode(message);
  }

  /**
   * Get public key for registration
   */
  getPublicKey(): string | null {
    if (!this.keypair) return null;
    
    return Array.from(this.keypair.publicKey)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Load Dilithium WASM module
   */
  private async loadDilithiumWasm(): Promise<any> {
    // Dynamic import for browser compatibility
    if (typeof window !== 'undefined') {
      // Browser environment
      const module = await import('@qnet/dilithium-wasm');
      await module.default();
      return module;
    } else {
      // Node.js environment (for testing)
      const { createRequire } = await import('module');
      const require = createRequire(import.meta.url);
      return require('@qnet/dilithium-native');
    }
  }

  /**
   * Save keys to secure storage
   */
  private async saveToStorage(keypair: DilithiumKeypair): Promise<void> {
    if (typeof window !== 'undefined') {
      // Browser: Use IndexedDB with encryption
      const encrypted = await this.encryptKeys(keypair);
      
      // Open IndexedDB
      const db = await this.openDatabase();
      const tx = db.transaction(['keys'], 'readwrite');
      const store = tx.objectStore('keys');
      
      await store.put({
        id: this.storageKey,
        data: encrypted,
        timestamp: Date.now()
      });
      
      await tx.complete;
    } else {
      // Node.js: Use encrypted file
      const fs = await import('fs/promises');
      const path = await import('path');
      const os = await import('os');
      
      const keyPath = path.join(os.homedir(), '.qnet', 'dilithium.key');
      const encrypted = await this.encryptKeys(keypair);
      
      await fs.mkdir(path.dirname(keyPath), { recursive: true });
      await fs.writeFile(keyPath, JSON.stringify(encrypted), 'utf8');
    }
  }

  /**
   * Load keys from secure storage
   */
  private async loadFromStorage(): Promise<DilithiumKeypair | null> {
    try {
      if (typeof window !== 'undefined') {
        // Browser: Load from IndexedDB
        const db = await this.openDatabase();
        const tx = db.transaction(['keys'], 'readonly');
        const store = tx.objectStore('keys');
        
        const record = await store.get(this.storageKey);
        if (!record) return null;
        
        return await this.decryptKeys(record.data);
      } else {
        // Node.js: Load from file
        const fs = await import('fs/promises');
        const path = await import('path');
        const os = await import('os');
        
        const keyPath = path.join(os.homedir(), '.qnet', 'dilithium.key');
        const data = await fs.readFile(keyPath, 'utf8');
        const encrypted = JSON.parse(data);
        
        return await this.decryptKeys(encrypted);
      }
    } catch (error) {
      console.log('No existing keys found');
      return null;
    }
  }

  /**
   * Open IndexedDB database
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
   * Encrypt keys for storage
   */
  private async encryptKeys(keypair: DilithiumKeypair): Promise<any> {
    // Get encryption key from user's password/PIN
    const encKey = await this.deriveStorageKey();
    
    // Use Web Crypto API for AES-GCM
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const algorithm = {
      name: 'AES-GCM',
      iv: iv
    };
    
    const keyData = new Uint8Array(
      keypair.publicKey.length + keypair.secretKey.length
    );
    keyData.set(keypair.publicKey, 0);
    keyData.set(keypair.secretKey, keypair.publicKey.length);
    
    const encrypted = await crypto.subtle.encrypt(
      algorithm,
      encKey,
      keyData
    );
    
    return {
      iv: Array.from(iv),
      data: Array.from(new Uint8Array(encrypted))
    };
  }

  /**
   * Decrypt keys from storage
   */
  private async decryptKeys(encrypted: any): Promise<DilithiumKeypair> {
    const encKey = await this.deriveStorageKey();
    
    const algorithm = {
      name: 'AES-GCM',
      iv: new Uint8Array(encrypted.iv)
    };
    
    const decrypted = await crypto.subtle.decrypt(
      algorithm,
      encKey,
      new Uint8Array(encrypted.data)
    );
    
    const keyData = new Uint8Array(decrypted);
    
    return {
      publicKey: keyData.slice(0, DILITHIUM_PUBLIC_KEY_SIZE),
      secretKey: keyData.slice(DILITHIUM_PUBLIC_KEY_SIZE)
    };
  }

  /**
   * Derive storage encryption key from user credentials
   */
  private async deriveStorageKey(): Promise<CryptoKey> {
    // In production, get from user's password/PIN
    // For now, use device-specific key
    const encoder = new TextEncoder();
    const keyMaterial = encoder.encode(
      navigator.userAgent + '_qnet_storage_v1'
    );
    
    const keyHash = await crypto.subtle.digest('SHA-256', keyMaterial);
    
    return crypto.subtle.importKey(
      'raw',
      keyHash,
      'AES-GCM',
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Clear keys from memory
   */
  clearKeys(): void {
    if (this.keypair) {
      // Overwrite with random data
      crypto.getRandomValues(this.keypair.secretKey);
      crypto.getRandomValues(this.keypair.publicKey);
      this.keypair = null;
    }
  }
}

// Export singleton instance
export const dilithiumManager = new DilithiumManager();
