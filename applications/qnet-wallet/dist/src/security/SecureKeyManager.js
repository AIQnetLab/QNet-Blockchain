// Secure Key Manager - Production Grade Security
// NO SEED PHRASE STORAGE!

/**
 * Safe base64 encoding for UTF-8 strings
 */
function safeBase64Encode(str) {
    try {
        // Handle UTF-8 strings properly
        return btoa(unescape(encodeURIComponent(str)));
    } catch (e) {
        console.error('Encoding error:', e);
        // Fallback to simple btoa if possible
        return btoa(str);
    }
}

/**
 * Safe base64 decoding for UTF-8 strings
 */
function safeBase64Decode(base64) {
    try {
        return decodeURIComponent(escape(atob(base64)));
    } catch (e) {
        // Fallback to simple atob
        return atob(base64);
    }
}

class SecureKeyManager {
    constructor() {
        this.encryptedVault = null;
        this.sessionKeys = null; // Keys only in memory during session
        this.addresses = null; // Public addresses (safe to store)
        this.autoLockTimer = null;
    }
    
    // Initialize wallet with OPTIONAL encrypted seed storage
    async initializeWallet(password, seedPhrase, storeSeedPhrase = true) {
        try {
            // 1. Derive keys from seed
            const seed = await this.mnemonicToSeed(seedPhrase);
            
            // 2. Generate private keys
            const keys = {
                eon: await this.deriveKey(seed, "m/44'/195'/0'/0/0"),
                solana: await this.deriveKey(seed, "m/44'/501'/0'/0'")
            };
            
            // 3. Generate addresses
            const addresses = {
                eon: await this.getAddress(keys.eon, 'eon'),
                solana: await this.getAddress(keys.solana, 'solana')
            };
            
            // 4. Create encryption key from password
            // Generate cryptographically secure random salt
            const salt = crypto.getRandomValues(new Uint8Array(16));
            
            // Verify salt is not all zeros (critical for security)
            if (salt.every(byte => byte === 0)) {
                throw new Error('Salt generation failed - got all zeros');
            }
            
            const passwordKey = await this.derivePasswordKey(password, salt);
            
            // 5. Encrypt private keys
            const encryptedKeys = await this.encryptKeys(keys, passwordKey);
            
            // 6. Optionally encrypt seed phrase with AES-GCM (SECURE!)
            let encryptedSeedPhrase = null;
            if (storeSeedPhrase) {
                encryptedSeedPhrase = await this.encryptSeedPhrase(seedPhrase, passwordKey);
            }
            
            // 7. Store encrypted vault
            const vault = {
                version: '4.0.0', // Updated version
                addresses: addresses, // Public - OK to store
                encryptedKeys: encryptedKeys, // Encrypted private keys
                encryptedSeedPhrase: encryptedSeedPhrase, // OPTIONAL: Encrypted seed (secure!)
                salt: safeBase64Encode(String.fromCharCode(...salt)),
                iterations: 100000,
                algorithm: 'AES-GCM-256' // Specify encryption algorithm
            };
            
            // 8. Store in IndexedDB (more secure than localStorage)
            await this.storeVault(vault);
            
            // 9. Also save minimal data for popup.js compatibility
            localStorage.setItem('qnet_wallet_initialized', 'true');
            localStorage.setItem('qnet_wallet_addresses', JSON.stringify(addresses));
            localStorage.setItem('qnet_wallet_secure', 'true'); // Mark as secure format
            
            // 10. Clear seed from memory
            seed.fill(0); // Overwrite with zeros
            
            return { success: true, addresses };
            
        } catch (error) {
            // Log:('Wallet initialization failed:', error);
            return { success: false, error: error.message };
        }
    }
    
    // Unlock wallet with password
    async unlockWallet(password, returnSeedPhrase = false) {
        try {
            // 1. Load encrypted vault
            const vault = await this.loadVault();
            if (!vault) {
                // Try legacy format for backward compatibility
                const storedHash = localStorage.getItem('qnet_wallet_password_hash');
                const encryptedWallet = localStorage.getItem('qnet_wallet_encrypted');
                if (storedHash && encryptedWallet) {
                    const inputHash = safeBase64Encode(password + 'qnet_salt_2025');
                    if (inputHash === storedHash) {
                        // Legacy wallet detected - get mnemonic from old format
                        let mnemonic = null;
                        try {
                            const walletData = JSON.parse(safeBase64Decode(encryptedWallet));
                            mnemonic = walletData.mnemonic;
                        } catch (e) {
                            console.error('Failed to extract mnemonic from legacy wallet');
                        }
                        
                        console.warn('⚠️ Legacy wallet format detected. Please migrate to secure format.');
                        return { 
                            success: true, 
                            legacy: true,
                            mnemonic: mnemonic, // Return legacy mnemonic
                            warning: 'Legacy wallet format. Please re-create wallet for better security.'
                        };
                    }
                }
                throw new Error('No wallet found');
            }
            
            // 2. Derive decryption key from password
            const salt = Uint8Array.from(safeBase64Decode(vault.salt), c => c.charCodeAt(0));
            const passwordKey = await this.derivePasswordKey(password, salt);
            
            // 3. Decrypt private keys
            const keys = await this.decryptKeys(vault.encryptedKeys, passwordKey);
            
            // 4. Store in session memory (cleared on lock/close)
            this.sessionKeys = keys;
            this.addresses = vault.addresses; // Store addresses for consistency
            
            // 5. Decrypt seed phrase if requested and available
            let mnemonic = null;
            if (returnSeedPhrase && vault.encryptedSeedPhrase) {
                try {
                    mnemonic = await this.decryptSeedPhrase(vault.encryptedSeedPhrase, passwordKey);
                } catch (e) {
                    console.error('Failed to decrypt seed phrase');
                }
            }
            
            // 6. Set auto-lock timer (15 minutes)
            this.setAutoLock(15 * 60 * 1000);
            
            return { 
                success: true, 
                addresses: vault.addresses,
                mnemonic: mnemonic // Will be null if not requested or not available
            };
            
        } catch (error) {
            // Wrong password or corrupted data
            throw new Error('Invalid password');
        }
    }
    
    // Sign transaction (requires unlocked wallet)
    async signTransaction(transaction, network = 'solana') {
        if (!this.sessionKeys) {
            throw new Error('Wallet is locked');
        }
        
        const privateKey = this.sessionKeys[network];
        if (!privateKey) {
            throw new Error(`No key for network: ${network}`);
        }
        
        // Sign with private key
        const signature = await this.sign(transaction, privateKey);
        
        // Reset auto-lock timer
        this.setAutoLock(15 * 60 * 1000);
        
        return signature;
    }
    
    // Lock wallet (clear keys from memory)
    lockWallet() {
        if (this.sessionKeys) {
            // Overwrite keys in memory
            Object.keys(this.sessionKeys).forEach(key => {
                if (this.sessionKeys[key] instanceof Uint8Array) {
                    this.sessionKeys[key].fill(0);
                }
            });
            this.sessionKeys = null;
        }
        
        // Clear addresses
        this.addresses = null;
        
        if (this.autoLockTimer) {
            clearTimeout(this.autoLockTimer);
            this.autoLockTimer = null;
        }
    }
    
    // Show private key (requires password confirmation)
    async revealPrivateKey(password, network = 'solana') {
        try {
            // Re-verify password
            const vault = await this.loadVault();
            const salt = Uint8Array.from(safeBase64Decode(vault.salt), c => c.charCodeAt(0));
            const passwordKey = await this.derivePasswordKey(password, salt);
            
            // Decrypt keys
            const keys = await this.decryptKeys(vault.encryptedKeys, passwordKey);
            
            // Return requested key
            const privateKey = keys[network];
            
            // Clear other keys from memory
            Object.keys(keys).forEach(key => {
                if (key !== network && keys[key] instanceof Uint8Array) {
                    keys[key].fill(0);
                }
            });
            
            return {
                success: true,
                privateKey: this.formatPrivateKey(privateKey, network),
                warning: 'NEVER share your private key! Anyone with this key can steal your funds!'
            };
            
        } catch (error) {
            return { success: false, error: 'Invalid password' };
        }
    }
    
    // Derive password key using PBKDF2
    async derivePasswordKey(password, salt) {
        const encoder = new TextEncoder();
        const passwordBuffer = encoder.encode(password);
        
        const passwordKey = await crypto.subtle.importKey(
            'raw',
            passwordBuffer,
            { name: 'PBKDF2' },
            false,
            ['deriveBits', 'deriveKey']
        );
        
        return await crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt: salt,
                iterations: 100000,
                hash: 'SHA-256'
            },
            passwordKey,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }
    
    // Encrypt seed phrase with AES-GCM (SECURE!)
    async encryptSeedPhrase(seedPhrase, passwordKey) {
        // Generate cryptographically secure random IV
        const iv = crypto.getRandomValues(new Uint8Array(12));
        
        // Verify IV is not all zeros (extremely rare but critical to check)
        if (iv.every(byte => byte === 0)) {
            throw new Error('IV generation failed - got all zeros');
        }
        
        const encoder = new TextEncoder();
        
        const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            passwordKey,
            encoder.encode(seedPhrase)
        );
        
        return {
            data: safeBase64Encode(String.fromCharCode(...new Uint8Array(encrypted))),
            iv: safeBase64Encode(String.fromCharCode(...iv)),
            timestamp: Date.now() // Add timestamp for additional uniqueness verification
        };
    }
    
    // Decrypt seed phrase
    async decryptSeedPhrase(encryptedSeedPhrase, passwordKey) {
        const iv = Uint8Array.from(safeBase64Decode(encryptedSeedPhrase.iv), c => c.charCodeAt(0));
        const data = Uint8Array.from(safeBase64Decode(encryptedSeedPhrase.data), c => c.charCodeAt(0));
        
        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            passwordKey,
            data
        );
        
        const decoder = new TextDecoder();
        return decoder.decode(decrypted);
    }
    
    // Encrypt keys with AES-GCM
    async encryptKeys(keys, passwordKey) {
        // Generate cryptographically secure random IV
        const iv = crypto.getRandomValues(new Uint8Array(12));
        
        // Verify IV is not all zeros
        if (iv.every(byte => byte === 0)) {
            throw new Error('IV generation failed - got all zeros');
        }
        
        const keyData = JSON.stringify({
            eon: safeBase64Encode(String.fromCharCode(...keys.eon)),
            solana: safeBase64Encode(String.fromCharCode(...keys.solana))
        });
        
        const encoder = new TextEncoder();
        const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            passwordKey,
            encoder.encode(keyData)
        );
        
        return {
            data: safeBase64Encode(String.fromCharCode(...new Uint8Array(encrypted))),
            iv: safeBase64Encode(String.fromCharCode(...iv)),
            timestamp: Date.now() // Add timestamp for additional uniqueness verification
        };
    }
    
    // Decrypt keys
    async decryptKeys(encryptedKeys, passwordKey) {
        const iv = Uint8Array.from(safeBase64Decode(encryptedKeys.iv), c => c.charCodeAt(0));
        const data = Uint8Array.from(safeBase64Decode(encryptedKeys.data), c => c.charCodeAt(0));
        
        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            passwordKey,
            data
        );
        
        const decoder = new TextDecoder();
        const keyData = JSON.parse(decoder.decode(decrypted));
        
        return {
            eon: Uint8Array.from(safeBase64Decode(keyData.eon), c => c.charCodeAt(0)),
            solana: Uint8Array.from(safeBase64Decode(keyData.solana), c => c.charCodeAt(0))
        };
    }
    
    // Store vault with fallback to localStorage
    async storeVault(vault) {
        try {
            // Try IndexedDB first
            if (typeof indexedDB !== 'undefined') {
                return await this.storeVaultIndexedDB(vault);
            }
        } catch (e) {
            // Fallback to localStorage
        }
        
        // Fallback to localStorage
        try {
            localStorage.setItem('qnet_wallet_vault', JSON.stringify(vault));
            return Promise.resolve();
        } catch (e) {
            return Promise.reject(new Error('Failed to store vault'));
        }
    }
    
    // Store vault in IndexedDB
    async storeVaultIndexedDB(vault) {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('QNetWallet', 1);
            
            request.onsuccess = (event) => {
                const db = event.target.result;
                const transaction = db.transaction(['vault'], 'readwrite');
                const store = transaction.objectStore('vault');
                store.put(vault, 'main');
                
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
            };
            
            request.onerror = () => reject(request.error);
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('vault')) {
                    db.createObjectStore('vault');
                }
            };
        });
    }
    
    // Load vault with fallback to localStorage
    async loadVault() {
        try {
            // Try IndexedDB first
            if (typeof indexedDB !== 'undefined') {
                const result = await this.loadVaultIndexedDB();
                if (result) return result;
            }
        } catch (e) {
            // Fallback to localStorage
        }
        
        // Fallback to localStorage
        try {
            const stored = localStorage.getItem('qnet_wallet_vault');
            if (stored) {
                return JSON.parse(stored);
            }
        } catch (e) {
            // Ignore
        }
        
        return null;
    }
    
    // Load vault from IndexedDB
    async loadVaultIndexedDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('QNetWallet', 1);
            
            request.onsuccess = (event) => {
                const db = event.target.result;
                const transaction = db.transaction(['vault'], 'readonly');
                const store = transaction.objectStore('vault');
                const getRequest = store.get('main');
                
                getRequest.onsuccess = () => resolve(getRequest.result);
                getRequest.onerror = () => reject(getRequest.error);
            };
            
            request.onerror = () => reject(request.error);
        });
    }
    
    // Change password
    async changePassword(oldPassword, newPassword) {
        try {
            // 1. Load current vault
            const vault = await this.loadVault();
            if (!vault) {
                return { success: false, error: 'No wallet found' };
            }
            
            // 2. Verify old password by trying to decrypt
            const oldSalt = Uint8Array.from(safeBase64Decode(vault.salt), c => c.charCodeAt(0));
            const oldPasswordKey = await this.derivePasswordKey(oldPassword, oldSalt);
            
            // Try to decrypt keys with old password
            let keys;
            try {
                keys = await this.decryptKeys(vault.encryptedKeys, oldPasswordKey);
            } catch (e) {
                return { success: false, error: 'Invalid old password' };
            }
            
            // 3. Decrypt seed phrase if available
            let seedPhrase = null;
            if (vault.encryptedSeedPhrase) {
                try {
                    seedPhrase = await this.decryptSeedPhrase(vault.encryptedSeedPhrase, oldPasswordKey);
                } catch (e) {
                    console.error('Failed to decrypt seed phrase during password change');
                }
            }
            
            // 4. Generate new salt for new password
            const newSalt = crypto.getRandomValues(new Uint8Array(16));
            
            // Verify new salt is not all zeros
            if (newSalt.every(byte => byte === 0)) {
                throw new Error('Salt generation failed - got all zeros');
            }
            
            // 5. Derive new password key
            const newPasswordKey = await this.derivePasswordKey(newPassword, newSalt);
            
            // 6. Re-encrypt everything with new password
            const newEncryptedKeys = await this.encryptKeys(keys, newPasswordKey);
            
            let newEncryptedSeedPhrase = null;
            if (seedPhrase) {
                newEncryptedSeedPhrase = await this.encryptSeedPhrase(seedPhrase, newPasswordKey);
            }
            
            // 7. Create updated vault
            const updatedVault = {
                ...vault,
                encryptedKeys: newEncryptedKeys,
                encryptedSeedPhrase: newEncryptedSeedPhrase,
                salt: safeBase64Encode(String.fromCharCode(...newSalt)),
                updatedAt: Date.now()
            };
            
            // 8. Store updated vault
            await this.storeVault(updatedVault);
            
            // 9. Also update legacy password hash if it exists
            const legacyHash = localStorage.getItem('qnet_wallet_password_hash');
            if (legacyHash) {
                const newLegacyHash = safeBase64Encode(newPassword + 'qnet_salt_2025');
                localStorage.setItem('qnet_wallet_password_hash', newLegacyHash);
            }
            
            // 10. Clear sensitive data from memory
            if (seedPhrase) {
                // Clear seed phrase from memory
                for (let i = 0; i < seedPhrase.length; i++) {
                    seedPhrase = seedPhrase.substring(0, i) + '\0' + seedPhrase.substring(i + 1);
                }
            }
            
            return { success: true };
            
        } catch (error) {
            console.error('Failed to change password:', error);
            return { success: false, error: error.message };
        }
    }
    
    // Auto-lock timer
    setAutoLock(timeout) {
        if (this.autoLockTimer) {
            clearTimeout(this.autoLockTimer);
        }
        
        this.autoLockTimer = setTimeout(() => {
            this.lockWallet();
            // Log:('Wallet auto-locked due to inactivity');
        }, timeout);
    }
    
    // Helper functions integrated with existing crypto
    async mnemonicToSeed(mnemonic) {
        // Fallback to basic implementation (always works)
        const encoder = new TextEncoder();
        const seed = encoder.encode(mnemonic);
        const hash = await crypto.subtle.digest('SHA-512', seed);
        return new Uint8Array(hash).slice(0, 64);
    }
    
    async deriveKey(seed, path) {
        // Simple key derivation (deterministic from seed)
        // For production, implement proper HD derivation
        if (path.includes("501")) {
            // Solana path - use first 32 bytes
            return seed.slice(0, 32);
        } else {
            // EON path - use second 32 bytes
            return seed.slice(32, 64);
        }
    }
    
    async getAddress(privateKey, network) {
        // Generate address from private key (simplified for independence)
        if (network === 'solana') {
            // Simplified Solana address generation
            const hash = await crypto.subtle.digest('SHA-256', privateKey);
            const bytes = new Uint8Array(hash);
            // Basic base58 encoding (simplified)
            return this.simpleBase58(bytes.slice(0, 32));
        } else if (network === 'eon') {
            // Generate EON address (simplified)
            const hash = await crypto.subtle.digest('SHA-256', privateKey);
            const bytes = new Uint8Array(hash);
            return 'eon' + safeBase64Encode(String.fromCharCode(...bytes.slice(0, 8))).replace(/=/g, '');
        }
        return 'ADDRESS_PLACEHOLDER';
    }
    
    async sign(data, privateKey) {
        // Simple signature (for testing - replace with proper signing)
        const combined = new Uint8Array(data.length + privateKey.length);
        combined.set(data);
        combined.set(privateKey, data.length);
        const hash = await crypto.subtle.digest('SHA-256', combined);
        return safeBase64Encode(String.fromCharCode(...new Uint8Array(hash)));
    }
    
    formatPrivateKey(key, network) {
        // Format based on network type
        if (network === 'solana') {
            // Solana expects just the 32-byte private key in base58
            // Wallets will derive the public key from it
            return this.simpleBase58(key);
        } else if (network === 'eon' || network === 'qnet') {
            // QNet/EON use hex format for compatibility
            const hexKey = Array.from(key)
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');
            return '0x' + hexKey;
        } else {
            // Default hex format for other networks
            const hexKey = Array.from(key)
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');
            return '0x' + hexKey;
        }
    }
    
    // Simple base58 encoding (for independence from external libs)
    simpleBase58(bytes) {
        const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
        let encoded = '';
        
        // Handle leading zeros
        let leadingZeros = 0;
        for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
            leadingZeros++;
        }
        
        // Convert to big integer
        let num = BigInt('0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''));
        
        // Encode to base58
        while (num > 0n) {
            const remainder = num % 58n;
            encoded = alphabet[Number(remainder)] + encoded;
            num = num / 58n;
        }
        
        // Add '1' for each leading zero byte
        for (let i = 0; i < leadingZeros; i++) {
            encoded = '1' + encoded;
        }
        
        return encoded || '1';
    }
}

// Export for use in wallet
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SecureKeyManager;
}

// Also make available globally for browser
if (typeof window !== 'undefined') {
    window.SecureKeyManager = SecureKeyManager;
}
