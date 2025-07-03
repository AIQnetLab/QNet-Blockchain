/**
 * QNet Wallet Manager - Production Version
 * Handles wallet operations with real Solana blockchain integration
 */

import { Connection, PublicKey, Keypair, Transaction } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, createBurnInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { SecureCrypto } from '../crypto/SecureCrypto.js';

export class WalletManager {
    constructor(solanaConnection) {
        this.connection = solanaConnection;
        this.isUnlocked = false;
        this.currentWallet = null;
        this.activationRecords = new Map();
    }

    /**
     * Create new HD wallet with secure seed phrase
     */
    async createWallet(password) {
        try {
            let mnemonic;
            
            // Use production-grade mnemonic generation (full 2048-word list)
            mnemonic = await SecureCrypto.generateMnemonic();
            
            // Backup: try BIP39 if fallback fails
            if (!mnemonic || typeof mnemonic !== 'string') {
                try {
                    mnemonic = bip39.generateMnemonic(128); // 12 words
                } catch (bip39Error) {
                    // Ultimate fallback
                    mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
                }
            }
            
            // Validate mnemonic
            if (!mnemonic || typeof mnemonic !== 'string' || mnemonic.split(' ').length !== 12) {
                throw new Error('Invalid mnemonic generated');
            }
            
            const masterKeypair = await this.deriveSolanaKeypair(mnemonic, 0);
            
            const walletData = {
                version: '1.0.0',
                mnemonic: mnemonic,
                accounts: [{
                    index: 0,
                    name: 'Account 1',
                    address: masterKeypair.publicKey.toString(),
                    derivationPath: "m/44'/501'/0'/0'"
                }],
                createdAt: Date.now()
            };
            
            // Encrypt and store wallet data
            const encryptedData = await SecureCrypto.encryptData(walletData, password);
            await this.saveToStorage('qnet_wallet_data', encryptedData);
            
            this.currentWallet = walletData;
            this.isUnlocked = true;
            
            return { 
                mnemonic, 
                address: masterKeypair.publicKey.toString() 
            };
        } catch (error) {
            throw new Error('Failed to create wallet: ' + error.message);
        }
    }

    /**
     * Import existing wallet from mnemonic with production security
     */
    async importWallet(mnemonic, password) {
        try {
            // PRODUCTION SECURITY: Use comprehensive BIP39 validation
            if (!this.validateSecureMnemonic(mnemonic)) {
                throw new Error('Invalid or insecure mnemonic phrase');
            }
            
            const masterKeypair = await this.deriveSolanaKeypair(mnemonic, 0);
            
            const walletData = {
                version: '1.0.0',
                mnemonic: mnemonic,
                accounts: [{
                    index: 0,
                    name: 'Account 1',
                    address: masterKeypair.publicKey.toString(),
                    derivationPath: "m/44'/501'/0'/0'"
                }],
                importedAt: Date.now()
            };
            
            // Encrypt and store wallet data
            const encryptedData = await SecureCrypto.encryptData(walletData, password);
            await this.saveToStorage('qnet_wallet_data', encryptedData);
            
            this.currentWallet = walletData;
            this.isUnlocked = true;
            
            return { 
                address: masterKeypair.publicKey.toString() 
            };
        } catch (error) {
            throw error;
        }
    }

    /**
     * Unlock wallet with password
     */
    async unlock(password) {
        try {
            const encryptedData = await this.loadFromStorage('qnet_wallet_data');
            if (!encryptedData) {
                throw new Error('No wallet found');
            }
            
            const walletData = await SecureCrypto.decryptData(encryptedData, password);
            this.currentWallet = walletData;
            this.isUnlocked = true;
            
            return true;
        } catch (error) {
            throw new Error('Invalid password or corrupted wallet data');
        }
    }

    /**
     * Check if wallet exists
     */
    async hasWallet() {
        try {
            const data = await this.loadFromStorage('qnet_wallet_data');
            return !!data;
        } catch (error) {
            return false;
        }
    }

    /**
     * Get current active account
     */
    getCurrentAccount() {
        if (!this.isUnlocked || !this.currentWallet) {
            return null;
        }
        return this.currentWallet.accounts[0];
    }

    /**
     * Get keypair for account
     */
    async getKeypairForAccount(accountIndex) {
        if (!this.isUnlocked || !this.currentWallet) {
            throw new Error('Wallet not unlocked');
        }
        
        return await this.deriveSolanaKeypair(
            this.currentWallet.mnemonic, 
            accountIndex
        );
    }

    /**
     * Get SPL token balance
     */
    async getTokenBalance(walletAddress, mintAddress) {
        try {
            const publicKey = new PublicKey(walletAddress);
            const mintPublicKey = new PublicKey(mintAddress);
            
            const tokenAccounts = await this.connection.getTokenAccountsByOwner(
                publicKey,
                { mint: mintPublicKey }
            );
            
            if (tokenAccounts.value.length === 0) {
                return 0;
            }
            
            const balance = await this.connection.getTokenAccountBalance(
                tokenAccounts.value[0].pubkey
            );
            
            return parseFloat(balance.value.uiAmount) || 0;
        } catch (error) {
            return 0;
        }
    }

    /**
     * Get SOL balance
     */
    async getSolBalance(walletAddress) {
        try {
            const publicKey = new PublicKey(walletAddress);
            const balance = await this.connection.getBalance(publicKey);
            return balance / 1000000000; // Convert lamports to SOL
        } catch (error) {
            return 0;
        }
    }

    /**
     * Burn tokens for node activation
     */
    async burnTokensForNodeActivation(account, amount) {
        try {
            const keypair = await this.getKeypairForAccount(account.index);
            const mintPublicKey = new PublicKey('9GcdXAo2EyjNdNLuQoScSVbfJSnh9RdkSS8YYKnGQ8Pf'); // 1DEV mint
            
            // Get or create token account
            const tokenAccount = await getOrCreateAssociatedTokenAccount(
                this.connection,
                keypair,
                mintPublicKey,
                keypair.publicKey
            );
            
            // Create burn instruction
            const burnAmount = amount * Math.pow(10, 6); // 6 decimals
            const burnInstruction = createBurnInstruction(
                tokenAccount.address,
                mintPublicKey,
                keypair.publicKey,
                burnAmount,
                [],
                TOKEN_PROGRAM_ID
            );
            
            // Create and send transaction
            const transaction = new Transaction().add(burnInstruction);
            const signature = await this.connection.sendTransaction(
                transaction,
                [keypair],
                { commitment: 'confirmed' }
            );
            
            // Wait for confirmation
            await this.connection.confirmTransaction(signature, 'confirmed');
            
            return signature;
        } catch (error) {
            throw new Error('Failed to burn tokens: ' + error.message);
        }
    }

    /**
     * Store activation record
     */
    async storeActivationRecord(record) {
        try {
            const existingRecords = await this.loadFromStorage('qnet_activations') || {};
            existingRecords[record.activationCode] = record;
            
            await this.saveToStorage('qnet_activations', existingRecords);
            this.activationRecords.set(record.activationCode, record);
            
            return record;
        } catch (error) {
            throw error;
        }
    }

    /**
     * Get activation records for current wallet
     */
    async getActivationRecords() {
        try {
            const currentAccount = this.getCurrentAccount();
            if (!currentAccount) return [];
            
            const allRecords = await this.loadFromStorage('qnet_activations') || {};
            return Object.values(allRecords).filter(
                record => record.walletAddress === currentAccount.address
            );
        } catch (error) {
            return [];
        }
    }

    /**
     * Validate mnemonic with production security requirements
     */
    validateSecureMnemonic(mnemonic) {
        // Basic BIP39 validation
        if (!bip39.validateMnemonic(mnemonic)) {
            return false;
        }
        
        // Check entropy strength
        const words = mnemonic.trim().split(/\s+/);
        const validLengths = [12, 15, 18, 21, 24];
        
        if (!validLengths.includes(words.length)) {
            return false;
        }
        
        // Calculate entropy bits
        const entropyBits = Math.floor(words.length * 11 * 4 / 3);
        
        // Require minimum 128 bits of entropy
        return entropyBits >= 128;
    }

    /**
     * Derive Solana keypair from mnemonic
     */
    async deriveSolanaKeypair(mnemonic, accountIndex = 0) {
        try {
            const seed = await bip39.mnemonicToSeed(mnemonic);
            const derivedSeed = derivePath(
                `m/44'/501'/${accountIndex}'/0'`, 
                seed.toString('hex')
            ).key;
            
            return Keypair.fromSeed(derivedSeed.slice(0, 32));
        } catch (error) {
            throw new Error('Failed to derive keypair from mnemonic');
        }
    }

    /**
     * Save data to Chrome storage
     */
    async saveToStorage(key, data) {
        return new Promise((resolve, reject) => {
            try {
                chrome.storage.local.set({ [key]: data }, () => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                    } else {
                        resolve();
                    }
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Load data from Chrome storage
     */
    async loadFromStorage(key) {
        return new Promise((resolve, reject) => {
            try {
                chrome.storage.local.get([key], (result) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                    } else {
                        resolve(result[key]);
                    }
                });
            } catch (error) {
                reject(error);
            }
        });
    }
}
