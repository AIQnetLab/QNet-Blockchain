/**
 * Production QNet Wallet Manager - Advanced Security
 * Complete wallet management with proper authentication and security
 */

import { SecureCrypto } from '../crypto/SecureCrypto.js';

function _cryptoHex(byteLen) {
    const b = new Uint8Array(byteLen);
    crypto.getRandomValues(b);
    return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}

export class WalletManager {
    // Rate-limit constants
    static RATE_LIMIT_KEY = 'qnet_ext_rate_limit';
    static MAX_DELAY_MS   = 300_000; // 5 min cap

    constructor() {
        this.isUnlocked = false;
        this.currentWallet = null;
        this.accounts = [];
        this.network = 'testnet';
        this.autoLockTimer = null;
        this.crypto = new SecureCrypto();
        this.isInitialized = false;
        this._failedAttempts = 0;
        this._lockoutUntil = 0;
    }

    /**
     * Initialize wallet manager
     */
    async initialize() {
        try {
            await this.checkWalletExists();
            this.isInitialized = true;
            return true;
        } catch (error) {
            console.error('Failed to initialize wallet:', error);
            throw error;
        }
    }

    /**
     * Check if wallet exists in storage
     */
    async checkWalletExists() {
        try {
            const result = await chrome.storage.local.get(['qnet_wallet_data']);
            this.hasWallet = !!result.qnet_wallet_data;
            return this.hasWallet;
        } catch (error) {
            console.error('Error checking wallet existence:', error);
            this.hasWallet = false;
            return false;
        }
    }

    /**
     * Create new wallet with proper security
     */
    async createWallet(password) {
        try {
            // Validate password strength
            if (!this.validatePasswordStrength(password)) {
                throw new Error('Password too weak. Use at least 8 characters with mixed case, numbers, and symbols.');
            }

            // Generate secure mnemonic
            const mnemonic = await this.generateSecureMnemonic();
            
            // Create wallet structure
            const walletData = {
                version: '2.0.0',
                created: Date.now(),
                network: this.network,
                accounts: [],
                settings: {
                    autoLock: 300, // 5 minutes
                    currency: 'USD',
                    language: 'en'
                }
            };

            // Create first account
            const firstAccount = await this.createAccountFromMnemonic(mnemonic, 0);
            walletData.accounts.push(firstAccount);

            // Encrypt and store wallet
            const encryptedData = await this.crypto.encryptData(walletData, password);
            await chrome.storage.local.set({ qnet_wallet_data: encryptedData });

            // Set current state
            this.currentWallet = walletData;
            this.isUnlocked = true;
            this.hasWallet = true;
            this.startAutoLockTimer();

            return {
                success: true,
                mnemonic: mnemonic,
                address: firstAccount.address,
                solanaAddress: firstAccount.solanaAddress
            };

        } catch (error) {
            console.error('Error creating wallet:', error);
            throw error;
        }
    }

    /**
     * Import existing wallet from mnemonic
     */
    async importWallet(mnemonic, password) {
        try {
            // Validate password
            if (!this.validatePasswordStrength(password)) {
                throw new Error('Password too weak. Use at least 8 characters with mixed case, numbers, and symbols.');
            }

            // Validate mnemonic
            if (!await this.validateMnemonic(mnemonic)) {
                throw new Error('Invalid mnemonic phrase. Please check your words and try again.');
            }

            // Create wallet structure
            const walletData = {
                version: '2.0.0',
                created: Date.now(),
                imported: true,
                network: this.network,
                accounts: [],
                settings: {
                    autoLock: 300,
                    currency: 'USD',
                    language: 'en'
                }
            };

            // Create first account from mnemonic
            const firstAccount = await this.createAccountFromMnemonic(mnemonic, 0);
            walletData.accounts.push(firstAccount);

            // Encrypt and store
            const encryptedData = await this.crypto.encryptData(walletData, password);
            await chrome.storage.local.set({ qnet_wallet_data: encryptedData });

            // Set current state
            this.currentWallet = walletData;
            this.isUnlocked = true;
            this.hasWallet = true;
            this.startAutoLockTimer();

            return {
                success: true,
                address: firstAccount.address,
                solanaAddress: firstAccount.solanaAddress
            };

        } catch (error) {
            console.error('Error importing wallet:', error);
            throw error;
        }
    }

    /**
     * Unlock wallet with password - PROPER AUTHENTICATION
     */
    async unlock(password) {
        try {
            if (!this.hasWallet) {
                throw new Error('No wallet found. Please create or import a wallet first.');
            }

            // Get encrypted data
            const result = await chrome.storage.local.get(['qnet_wallet_data']);
            if (!result.qnet_wallet_data) {
                throw new Error('Wallet data not found.');
            }

            // Decrypt wallet data with password
            const walletData = await this.crypto.decryptData(result.qnet_wallet_data, password);
            
            // Validate wallet structure
            if (!walletData.accounts || !Array.isArray(walletData.accounts)) {
                throw new Error('Invalid wallet data structure.');
            }

            // Set current state
            this.currentWallet = walletData;
            this.isUnlocked = true;
            this.startAutoLockTimer();

            return {
                success: true,
                accountCount: walletData.accounts.length
            };

        } catch (error) {
            console.error('Error unlocking wallet:', error);
            // Provide user-friendly error messages
            if (error.message.includes('decrypt') || error.message.includes('Authentication failed')) {
                throw new Error('Incorrect password. Please try again.');
            }
            throw error;
        }
    }

    /**
     * Lock wallet
     */
    async lock() {
        this.isUnlocked = false;
        this.currentWallet = null;
        this.clearAutoLockTimer();
        return { success: true };
    }

    /**
     * Get current account
     */
    getCurrentAccount() {
        if (!this.isUnlocked || !this.currentWallet || !this.currentWallet.accounts.length) {
            return null;
        }
        return this.currentWallet.accounts[0]; // Default to first account
    }

    /**
     * Get all accounts
     */
    getAllAccounts() {
        if (!this.isUnlocked || !this.currentWallet) {
            return [];
        }
        return this.currentWallet.accounts || [];
    }

    /**
     * Generate secure mnemonic
     */
    async generateSecureMnemonic() {
        try {
            // Use Web Crypto API for secure random generation
            const entropy = new Uint8Array(16); // 128 bits
            crypto.getRandomValues(entropy);
            
            // Convert to mnemonic using BIP39 wordlist
            const mnemonic = await this.crypto.generateMnemonic(entropy);
            
            if (!mnemonic || mnemonic.split(' ').length !== 12) {
                throw new Error('Failed to generate valid mnemonic');
            }

            return mnemonic;
        } catch (error) {
            console.error('Error generating mnemonic:', error);
            throw new Error('Failed to generate secure mnemonic');
        }
    }

    /**
     * Validate mnemonic phrase
     */
    async validateMnemonic(mnemonic) {
        if (!mnemonic || typeof mnemonic !== 'string') {
            return false;
        }

        const words = mnemonic.trim().toLowerCase().split(/\s+/);
        
        // Check word count
        if (![12, 15, 18, 21, 24].includes(words.length)) {
            return false;
        }

        // Use crypto validation
        return await this.crypto.validateMnemonic(mnemonic);
    }

    /**
     * Create account from mnemonic
     */
    async createAccountFromMnemonic(mnemonic, index = 0) {
        try {
            // Generate Solana keypair
            const solanaKeypair = await this.crypto.generateSolanaKeypair(mnemonic, index);

            // Generate the CANONICAL pure-Dilithium (ML-DSA-65) QNet wallet — address + key material.
            // Byte-identical to the Rust node + mobile app (golden-KAT proven). The sk/pk hex are
            // stored on the account so QNet value transfers can be signed client-side (signQNet).
            const qnetWallet = await this.crypto.deriveQNetWallet(mnemonic);

            return {
                index: index,
                name: `Account ${index + 1}`,
                address: qnetWallet.address,                 // EON address (from ML-DSA-65 pk)
                qnetPublicKey: qnetWallet.publicKey,         // ML-DSA-65 pk (hex, 1952B) — verify + sign
                qnetSecretKey: qnetWallet.secretKey,         // ML-DSA-65 sk (hex, 4032B) — sign
                solanaAddress: solanaKeypair.publicKey.toString(),
                derivationPath: `m/44'/501'/${index}'/0'`,
                created: Date.now()
            };

        } catch (error) {
            console.error('Error creating account:', error);
            throw new Error('Failed to create account from mnemonic');
        }
    }

    /**
     * Validate password strength
     */
    validatePasswordStrength(password) {
        if (!password || typeof password !== 'string') {
            return false;
        }

        // Minimum requirements
        const minLength = password.length >= 8;
        const hasLower = /[a-z]/.test(password);
        const hasUpper = /[A-Z]/.test(password);
        const hasNumber = /\d/.test(password);
        const hasSpecial = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\?]/.test(password);

        return minLength && hasLower && hasUpper && hasNumber && hasSpecial;
    }

    /**
     * Start auto-lock timer
     */
    startAutoLockTimer() {
        this.clearAutoLockTimer();
        
        const timeout = this.currentWallet?.settings?.autoLock || 300; // 5 minutes default
        if (timeout > 0) {
            this.autoLockTimer = setTimeout(() => {
                this.lock();
            }, timeout * 1000);
        }
    }

    /**
     * Clear auto-lock timer
     */
    clearAutoLockTimer() {
        if (this.autoLockTimer) {
            clearTimeout(this.autoLockTimer);
            this.autoLockTimer = null;
        }
    }

    /**
     * Reset auto-lock timer (on user activity)
     */
    resetAutoLockTimer() {
        if (this.isUnlocked) {
            this.startAutoLockTimer();
        }
    }

    /**
     * Get wallet status
     */
    getStatus() {
        return {
            hasWallet: this.hasWallet,
            isUnlocked: this.isUnlocked,
            isInitialized: this.isInitialized,
            network: this.network,
            accountCount: this.isUnlocked ? this.currentWallet?.accounts?.length || 0 : 0
        };
    }

    /**
     * Send transaction
     */
    async sendTransaction(params) {
        try {
            if (!this.isUnlocked) {
                throw new Error('Wallet is locked');
            }

            const account = this.getCurrentAccount();
            if (!account) {
                throw new Error('No active account');
            }

            // Validate transaction parameters
            this.validateTransactionParams(params);

            // Create transaction
            const transaction = {
                from: account.address,
                to: params.to,
                amount: params.amount,
                memo: params.memo || '',
                network: this.network,
                timestamp: Date.now(),
                hash: this.generateTransactionHash()
            };

            // Reset auto-lock timer
            this.resetAutoLockTimer();

            // Send to real blockchain based on network
            let result;
            if (this.network === 'solana') {
                result = await this.sendSolanaTransaction(transaction);
            } else if (this.network === 'qnet') {
                result = await this.sendQNetTransaction(transaction);
            } else {
                throw new Error(`Unsupported network: ${this.network}`);
            }

            // Store transaction in history
            await this.addTransactionToHistory(transaction);

            return result;
        } catch (error) {
            console.error('Transaction failed:', error);
            throw error;
        }
    }

    /**
     * Send Solana devnet transaction
     */
    async sendSolanaTransaction(transaction) {
        try {
            // Real Solana devnet integration - no mocks
            if (!this.networks?.solana?.connection) {
                throw new Error('Solana connection not available');
            }

            console.log('📤 Sending Solana devnet transaction:', transaction);

            // Use real Solana RPC for transaction
            const signature = await this.networks.solana.connection.sendTransaction(transaction);
            
            if (!signature) {
                throw new Error('Failed to get transaction signature from Solana devnet');
            }

            console.log('✅ Solana devnet transaction sent:', signature);

            return {
                signature: signature,
                confirmed: true,
                network: 'solana-devnet',
                timestamp: Date.now()
            };
        } catch (error) {
            console.error('Solana devnet transaction failed:', error);
            throw error;
        }
    }

    /**
     * Send QNet transaction — pure-Dilithium signed (ML-DSA-65).
     *
     * Builds the canonical transfer message the node's value-TX gate verifies:
     *   message = `transfer:${from}:${to}:${amountNano}:${nonce}:${gasPrice}:${gasLimit}`
     * signs it with the account's ML-DSA-65 secret key via the bundle (Q.signQNet), and POSTs the
     * wire-format signature + public key to /api/v1/transaction. `from` is the account EON address;
     * amount is integer nano-QNC. No plaintext private key is ever transmitted.
     */
    async sendQNetTransaction(transaction) {
        try {
            const account = this.getCurrentAccount();
            if (!account) {
                throw new Error('No active account');
            }

            const skHex = account.qnetSecretKey;
            const pkHex = account.qnetPublicKey;
            if (!skHex || !pkHex) {
                throw new Error('Account is missing Dilithium key material — cannot sign QNet transaction');
            }

            // Load the canonical signer from the bundle (window in page, self in worker).
            const g = (typeof window !== 'undefined') ? window
                    : (typeof self !== 'undefined') ? self
                    : (typeof globalThis !== 'undefined') ? globalThis : null;
            const Q = g && g.QNetDilithiumLib && g.QNetDilithiumLib.QNetDilithium;
            if (!Q || typeof Q.signQNet !== 'function') {
                throw new Error('QNetDilithium bundle not loaded — lib/noble-pq-ml-dsa.js must load before wallet code');
            }

            const from = account.address;                          // EON address
            const to = transaction.to;
            const amountNano = Math.floor(Number(transaction.amount) * 1_000_000_000); // integer nano-QNC
            const gasPrice = 10;
            const gasLimit = 21000;
            const nonce = Number.isInteger(transaction.nonce) ? transaction.nonce : 1;

            // Canonical message — EXACTLY the string the node re-derives and verifies against.
            const message = `transfer:${from}:${to}:${amountNano}:${nonce}:${gasPrice}:${gasLimit}`;
            const dilithiumSignature = Q.signQNet(message, skHex, pkHex);

            console.log('📤 Sending QNet Dilithium-signed transaction:', { from, to, amountNano, nonce });

            const response = await fetch('http://localhost:8080/api/v1/transaction', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    from: from,
                    to: to,
                    amount: amountNano,
                    dilithium_signature: dilithiumSignature,
                    dilithium_public_key: pkHex,
                    gas_price: gasPrice,
                    gas_limit: gasLimit,
                    nonce: nonce
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();

            if (data.success) {
                console.log('✅ QNet transaction sent:', data.tx_hash);
                return {
                    signature: data.tx_hash,
                    confirmed: true,
                    network: 'qnet',
                    timestamp: Date.now()
                };
            } else {
                throw new Error(data.error || 'QNet transaction failed');
            }

        } catch (error) {
            console.error('QNet transaction failed:', error);
            throw error;
        }
    }

    /**
     * Validate transaction parameters
     */
    validateTransactionParams(params) {
        if (!params.to || typeof params.to !== 'string') {
            throw new Error('Invalid recipient address');
        }

        if (!params.amount || isNaN(parseFloat(params.amount)) || parseFloat(params.amount) <= 0) {
            throw new Error('Invalid amount');
        }

        if (params.memo && params.memo.length > 256) {
            throw new Error('Memo too long (max 256 characters)');
        }
    }

    /**
     * Generate transaction hash
     */
    generateTransactionHash() {
        const timestamp = Date.now().toString();
        const random = _cryptoHex(16);
        return `0x${this.crypto.hash(timestamp + random)}`;
    }
} 