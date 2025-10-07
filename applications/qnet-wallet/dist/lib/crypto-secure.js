/**
 * Secure Crypto Implementation for QNet Wallet
 * Production-ready encryption and hashing
 */

/**
 * Encrypt data using AES-GCM with password-derived key
 * @param {string} data - Data to encrypt
 * @param {string} password - User password
 * @returns {Promise<{encrypted: string, salt: string, iv: string}>}
 */
async function encryptData(data, password) {
    // Generate random salt and IV
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    
    // Derive key from password using PBKDF2
    const key = await deriveKey(password, salt);
    
    // Encrypt data
    const encoder = new TextEncoder();
    const encodedData = encoder.encode(data);
    
    const encryptedData = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        encodedData
    );
    
    return {
        encrypted: bufferToBase64(encryptedData),
        salt: bufferToBase64(salt),
        iv: bufferToBase64(iv)
    };
}

/**
 * Decrypt data using AES-GCM
 * @param {string} encryptedData - Base64 encrypted data
 * @param {string} password - User password
 * @param {string} salt - Base64 salt
 * @param {string} iv - Base64 IV
 * @returns {Promise<string>} Decrypted data
 */
async function decryptData(encryptedData, password, salt, iv) {
    // Convert from base64
    const encryptedBuffer = base64ToBuffer(encryptedData);
    const saltBuffer = base64ToBuffer(salt);
    const ivBuffer = base64ToBuffer(iv);
    
    // Derive key from password
    const key = await deriveKey(password, saltBuffer);
    
    // Decrypt data
    const decryptedData = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: ivBuffer },
        key,
        encryptedBuffer
    );
    
    const decoder = new TextDecoder();
    return decoder.decode(decryptedData);
}

/**
 * Derive encryption key from password using PBKDF2
 * @param {string} password - User password
 * @param {Uint8Array} salt - Salt for key derivation
 * @returns {Promise<CryptoKey>} Derived key
 */
async function deriveKey(password, salt) {
    const encoder = new TextEncoder();
    const passwordBuffer = encoder.encode(password);
    
    // Import password
    const passwordKey = await crypto.subtle.importKey(
        'raw',
        passwordBuffer,
        { name: 'PBKDF2' },
        false,
        ['deriveKey']
    );
    
    // Derive AES key using PBKDF2
    return await crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: salt,
            iterations: 100000, // Industry standard
            hash: 'SHA-256'
        },
        passwordKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

/**
 * Hash password using PBKDF2 for verification
 * @param {string} password - Password to hash
 * @returns {Promise<{hash: string, salt: string}>} Hash and salt
 */
async function hashPassword(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const encoder = new TextEncoder();
    const passwordBuffer = encoder.encode(password);
    
    // Import password
    const passwordKey = await crypto.subtle.importKey(
        'raw',
        passwordBuffer,
        { name: 'PBKDF2' },
        false,
        ['deriveBits']
    );
    
    // Derive hash using PBKDF2
    const hash = await crypto.subtle.deriveBits(
        {
            name: 'PBKDF2',
            salt: salt,
            iterations: 100000,
            hash: 'SHA-256'
        },
        passwordKey,
        256 // 32 bytes
    );
    
    return {
        hash: bufferToBase64(hash),
        salt: bufferToBase64(salt)
    };
}

/**
 * Verify password against hash
 * @param {string} password - Password to verify
 * @param {string} hash - Base64 hash to compare
 * @param {string} salt - Base64 salt used for hashing
 * @returns {Promise<boolean>} True if password matches
 */
async function verifyPassword(password, hash, salt) {
    const saltBuffer = base64ToBuffer(salt);
    const encoder = new TextEncoder();
    const passwordBuffer = encoder.encode(password);
    
    // Import password
    const passwordKey = await crypto.subtle.importKey(
        'raw',
        passwordBuffer,
        { name: 'PBKDF2' },
        false,
        ['deriveBits']
    );
    
    // Derive hash
    const derivedHash = await crypto.subtle.deriveBits(
        {
            name: 'PBKDF2',
            salt: saltBuffer,
            iterations: 100000,
            hash: 'SHA-256'
        },
        passwordKey,
        256
    );
    
    const derivedHashBase64 = bufferToBase64(derivedHash);
    return derivedHashBase64 === hash;
}

/**
 * Convert ArrayBuffer to Base64
 */
function bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * Convert Base64 to ArrayBuffer
 */
function base64ToBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

/**
 * Generate secure random string for additional entropy
 */
function generateSecureRandom(length = 32) {
    const array = new Uint8Array(length);
    crypto.getRandomValues(array);
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}
