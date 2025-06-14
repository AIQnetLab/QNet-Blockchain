// QNet Secure Crypto Implementation
// Using Web Crypto API for Ed25519

export class SecureCrypto {
    constructor() {
        this.encoder = new TextEncoder();
        this.decoder = new TextDecoder();
    }
    
    // Generate Ed25519 key pair
    async generateKeyPair() {
        const keyPair = await crypto.subtle.generateKey(
            {
                name: "Ed25519",
                namedCurve: "Ed25519"
            },
            true, // extractable
            ["sign", "verify"]
        );
        
        return keyPair;
    }
    
    // Export private key
    async exportPrivateKey(privateKey) {
        const exported = await crypto.subtle.exportKey("pkcs8", privateKey);
        return this.arrayBufferToHex(exported);
    }
    
    // Export public key
    async exportPublicKey(publicKey) {
        const exported = await crypto.subtle.exportKey("raw", publicKey);
        return this.arrayBufferToHex(exported);
    }
    
    // Import private key
    async importPrivateKey(privateKeyHex) {
        const keyData = this.hexToArrayBuffer(privateKeyHex);
        return await crypto.subtle.importKey(
            "pkcs8",
            keyData,
            {
                name: "Ed25519",
                namedCurve: "Ed25519"
            },
            true,
            ["sign"]
        );
    }
    
    // Sign message with Ed25519
    async signMessage(message, privateKey) {
        const messageData = this.encoder.encode(message);
        const signature = await crypto.subtle.sign(
            "Ed25519",
            privateKey,
            messageData
        );
        return this.arrayBufferToHex(signature);
    }
    
    // Sign transaction
    async signTransaction(tx, privateKey) {
        // Canonical transaction format
        const txData = JSON.stringify({
            from: tx.from,
            to: tx.to,
            amount: tx.amount,
            memo: tx.memo || "",
            timestamp: tx.timestamp,
            nonce: tx.nonce
        });
        
        return await this.signMessage(txData, privateKey);
    }
    
    // Verify signature
    async verifySignature(message, signature, publicKey) {
        const messageData = this.encoder.encode(message);
        const signatureData = this.hexToArrayBuffer(signature);
        
        return await crypto.subtle.verify(
            "Ed25519",
            publicKey,
            signatureData,
            messageData
        );
    }
    
    // Generate secure random bytes
    generateRandomBytes(length) {
        const bytes = new Uint8Array(length);
        crypto.getRandomValues(bytes);
        return bytes;
    }
    
    // Generate secure random ID
    generateSecureId(prefix = '') {
        const timestamp = Date.now().toString(36);
        const randomBytes = this.generateRandomBytes(16);
        const randomHex = this.uint8ArrayToHex(randomBytes);
        return `${prefix}${timestamp}_${randomHex}`;
    }
    
    // Derive key from password with stronger parameters
    async deriveKeyFromPassword(password, salt = null) {
        const passwordBuffer = this.encoder.encode(password);
        
        // Generate salt if not provided
        if (!salt) {
            salt = this.generateRandomBytes(32);
        } else if (typeof salt === 'string') {
            salt = this.encoder.encode(salt);
        }
        
        // Import password as key material
        const keyMaterial = await crypto.subtle.importKey(
            'raw',
            passwordBuffer,
            'PBKDF2',
            false,
            ['deriveKey']
        );
        
        // Derive key with 250,000 iterations (stronger than before)
        const key = await crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt: salt,
                iterations: 250000, // Increased from 100,000
                hash: 'SHA-256'
            },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
        
        return { key, salt };
    }
    
    // Encrypt with AES-GCM (unchanged but with better key derivation)
    async encrypt(data, password) {
        const { key, salt } = await this.deriveKeyFromPassword(password);
        const iv = this.generateRandomBytes(12);
        
        const dataBuffer = this.encoder.encode(JSON.stringify(data));
        const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            key,
            dataBuffer
        );
        
        // Combine salt + iv + encrypted data
        const result = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
        result.set(salt, 0);
        result.set(iv, salt.length);
        result.set(new Uint8Array(encrypted), salt.length + iv.length);
        
        return this.uint8ArrayToHex(result);
    }
    
    // Decrypt with AES-GCM
    async decrypt(encryptedHex, password) {
        const encrypted = this.hexToUint8Array(encryptedHex);
        
        // Extract salt, iv, and ciphertext
        const salt = encrypted.slice(0, 32);
        const iv = encrypted.slice(32, 44);
        const ciphertext = encrypted.slice(44);
        
        const { key } = await this.deriveKeyFromPassword(password, salt);
        
        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            key,
            ciphertext
        );
        
        const dataStr = this.decoder.decode(decrypted);
        return JSON.parse(dataStr);
    }
    
    // Validate QNet address format
    validateAddress(address) {
        // QNet address format: qnet1 + base58 encoded data
        if (!address || typeof address !== 'string') {
            return false;
        }
        
        if (!address.startsWith('qnet1')) {
            return false;
        }
        
        const base58Part = address.slice(5);
        if (base58Part.length < 32 || base58Part.length > 44) {
            return false;
        }
        
        // Check for valid base58 characters
        const base58Regex = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;
        return base58Regex.test(base58Part);
    }
    
    // Validate amount
    validateAmount(amount) {
        if (typeof amount !== 'number' && typeof amount !== 'string') {
            return false;
        }
        
        const num = Number(amount);
        if (isNaN(num) || num <= 0) {
            return false;
        }
        
        // Maximum supply check (1 billion QNC)
        if (num > 1_000_000_000) {
            return false;
        }
        
        // Maximum 6 decimal places
        const decimalPlaces = (amount.toString().split('.')[1] || '').length;
        if (decimalPlaces > 6) {
            return false;
        }
        
        return true;
    }
    
    // Validate memo
    validateMemo(memo) {
        if (!memo) return true; // Optional
        
        if (typeof memo !== 'string') {
            return false;
        }
        
        // Maximum 256 characters
        if (memo.length > 256) {
            return false;
        }
        
        // No control characters
        const controlCharsRegex = /[\x00-\x1F\x7F]/;
        if (controlCharsRegex.test(memo)) {
            return false;
        }
        
        return true;
    }
    
    // Utility functions
    arrayBufferToHex(buffer) {
        return Array.from(new Uint8Array(buffer))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }
    
    hexToArrayBuffer(hex) {
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < hex.length; i += 2) {
            bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
        }
        return bytes.buffer;
    }
    
    uint8ArrayToHex(uint8Array) {
        return Array.from(uint8Array)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }
    
    hexToUint8Array(hex) {
        const result = new Uint8Array(hex.length / 2);
        for (let i = 0; i < hex.length; i += 2) {
            result[i / 2] = parseInt(hex.substr(i, 2), 16);
        }
        return result;
    }
} 