/**
 * Production Cryptography Module for QNet Wallet
 * Real encryption, key derivation, and address generation
 */

import * as bip39 from 'bip39';
import nacl from 'tweetnacl';
import CryptoJS from 'crypto-js';

/**
 * Production Wallet Cryptography Class
 */
export class ProductionCrypto {
    
    /**
     * Generate cryptographically secure mnemonic
     */
    static generateMnemonic() {
        try {
            return bip39.generateMnemonic(128); // 12 words
        } catch (error) {
            console.error('Failed to generate mnemonic:', error);
            throw new Error('Failed to generate secure mnemonic');
        }
    }
    
    /**
     * Validate BIP39 mnemonic
     */
    static validateMnemonic(mnemonic) {
        try {
            return bip39.validateMnemonic(mnemonic);
        } catch (error) {
            console.error('Mnemonic validation failed:', error);
            return false;
        }
    }
    
    /**
     * Derive seed from mnemonic with optional passphrase
     */
    static mnemonicToSeed(mnemonic, passphrase = '') {
        try {
            if (!this.validateMnemonic(mnemonic)) {
                throw new Error('Invalid mnemonic phrase');
            }
            return bip39.mnemonicToSeedSync(mnemonic, passphrase);
        } catch (error) {
            console.error('Seed derivation failed:', error);
            throw new Error('Failed to derive seed from mnemonic');
        }
    }
    
    /**
     * Generate Solana keypair from seed
     */
    static generateSolanaKeypair(seed, accountIndex = 0) {
        try {
            // Derive account-specific seed using HMAC
            const accountSeed = CryptoJS.HmacSHA256(
                `solana-account-${accountIndex}`, 
                CryptoJS.lib.WordArray.create(seed)
            );
            
            // Convert to Uint8Array for nacl
            const seedBytes = new Uint8Array(32);
            const words = accountSeed.words;
            for (let i = 0; i < 8; i++) {
                const word = words[i];
                seedBytes[i * 4] = (word >>> 24) & 0xff;
                seedBytes[i * 4 + 1] = (word >>> 16) & 0xff;
                seedBytes[i * 4 + 2] = (word >>> 8) & 0xff;
                seedBytes[i * 4 + 3] = word & 0xff;
            }
            
            // Generate Ed25519 keypair
            const keypair = nacl.sign.keyPair.fromSeed(seedBytes);
            
            return {
                publicKey: keypair.publicKey,
                secretKey: keypair.secretKey,
                address: this.publicKeyToAddress(keypair.publicKey)
            };
        } catch (error) {
            console.error('Solana keypair generation failed:', error);
            throw new Error('Failed to generate Solana keypair');
        }
    }
    
    /**
     * Convert public key to Solana address (base58)
     */
    static publicKeyToAddress(publicKey) {
        try {
            return this.base58Encode(publicKey);
        } catch (error) {
            console.error('Address conversion failed:', error);
            throw new Error('Failed to convert public key to address');
        }
    }
    
    /**
     * Generate QNet EON address from seed
     */
    static generateQNetAddress(seed, accountIndex = 0) {
        try {
            // Derive QNet-specific seed
            const qnetSeed = CryptoJS.HmacSHA256(
                `qnet-eon-${accountIndex}`, 
                CryptoJS.lib.WordArray.create(seed)
            );
            
            // Convert to hex and format as EON address
            const hex = qnetSeed.toString(CryptoJS.enc.Hex);
            
            // Format: 8chars + "eon" + 8chars + 4char checksum
            const part1 = hex.substring(0, 8);
            const part2 = hex.substring(8, 16);
            const checksum = hex.substring(56, 60); // Last 4 chars
            
            return `${part1}eon${part2}${checksum}`;
        } catch (error) {
            console.error('QNet address generation failed:', error);
            throw new Error('Failed to generate QNet address');
        }
    }
    
    /**
     * Encrypt wallet data with password
     */
    static encryptWalletData(walletData, password) {
        try {
            // Generate salt
            const salt = CryptoJS.lib.WordArray.random(256/8);
            
            // Derive key using PBKDF2
            const key = CryptoJS.PBKDF2(password, salt, {
                keySize: 256/32,
                iterations: 10000
            });
            
            // Generate IV
            const iv = CryptoJS.lib.WordArray.random(128/8);
            
            // Encrypt data
            const encrypted = CryptoJS.AES.encrypt(
                JSON.stringify(walletData), 
                key, 
                { iv: iv }
            );
            
            return {
                encrypted: encrypted.toString(),
                salt: salt.toString(),
                iv: iv.toString(),
                version: 1
            };
        } catch (error) {
            console.error('Wallet encryption failed:', error);
            throw new Error('Failed to encrypt wallet data');
        }
    }
    
    /**
     * Decrypt wallet data with password
     */
    static decryptWalletData(encryptedData, password) {
        try {
            const { encrypted, salt, iv } = encryptedData;
            
            // Recreate key from password and salt
            const key = CryptoJS.PBKDF2(password, CryptoJS.enc.Hex.parse(salt), {
                keySize: 256/32,
                iterations: 10000
            });
            
            // Decrypt data
            const decrypted = CryptoJS.AES.decrypt(
                encrypted, 
                key, 
                { iv: CryptoJS.enc.Hex.parse(iv) }
            );
            
            const decryptedString = decrypted.toString(CryptoJS.enc.Utf8);
            
            if (!decryptedString) {
                throw new Error('Invalid password or corrupted data');
            }
            
            return JSON.parse(decryptedString);
        } catch (error) {
            console.error('Wallet decryption failed:', error);
            throw new Error('Failed to decrypt wallet data - invalid password');
        }
    }
    
    /**
     * Sign message with private key
     */
    static signMessage(message, secretKey) {
        try {
            const messageBytes = new TextEncoder().encode(message);
            const signature = nacl.sign.detached(messageBytes, secretKey);
            return this.base58Encode(signature);
        } catch (error) {
            console.error('Message signing failed:', error);
            throw new Error('Failed to sign message');
        }
    }
    
    /**
     * Verify message signature
     */
    static verifySignature(message, signature, publicKey) {
        try {
            const messageBytes = new TextEncoder().encode(message);
            const signatureBytes = this.base58Decode(signature);
            return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKey);
        } catch (error) {
            console.error('Signature verification failed:', error);
            return false;
        }
    }
    
    /**
     * Base58 encoding (Bitcoin/Solana standard)
     */
    static base58Encode(bytes) {
        const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
        let result = '';
        let num = BigInt('0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''));
        
        while (num > 0) {
            result = alphabet[num % 58n] + result;
            num = num / 58n;
        }
        
        // Handle leading zeros
        for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
            result = '1' + result;
        }
        
        return result;
    }
    
    /**
     * Base58 decoding
     */
    static base58Decode(str) {
        const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
        let num = 0n;
        let multi = 1n;
        
        for (let i = str.length - 1; i >= 0; i--) {
            const char = str[i];
            const index = alphabet.indexOf(char);
            if (index === -1) throw new Error('Invalid base58 character');
            num += BigInt(index) * multi;
            multi *= 58n;
        }
        
        // Convert to bytes
        const hex = num.toString(16);
        const bytes = new Uint8Array((hex.length + 1) / 2);
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
        }
        
        return bytes;
    }
    
    /**
     * Generate secure random bytes
     */
    static randomBytes(length) {
        try {
            return crypto.getRandomValues(new Uint8Array(length));
        } catch (error) {
            console.error('Random bytes generation failed:', error);
            throw new Error('Failed to generate secure random bytes');
        }
    }
    
    /**
     * Hash data with SHA256
     */
    static sha256(data) {
        try {
            const hash = CryptoJS.SHA256(data);
            return hash.toString(CryptoJS.enc.Hex);
        } catch (error) {
            console.error('SHA256 hashing failed:', error);
            throw new Error('Failed to hash data');
        }
    }
}

// Browser compatibility
if (typeof window !== 'undefined') {
    window.ProductionCrypto = ProductionCrypto;
} 