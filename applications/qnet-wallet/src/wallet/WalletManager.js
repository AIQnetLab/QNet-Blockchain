// QNet Wallet Manager

import { SecureCrypto } from '../crypto/SecureCrypto.js';
import { StorageManager } from '../storage/StorageManager.js';
import { NetworkManager } from '../network/NetworkManager.js';
import { passwordPrompt } from '../ui/PasswordPrompt.js';
import { bip39Wordlist } from '../crypto/BIP39Wordlist.js';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import CryptoJS from 'crypto-js';
import { Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';

export class WalletManager {
    constructor() {
        this.crypto = new SecureCrypto();
        this.storage = new StorageManager();
        this.network = new NetworkManager();
        
        this.vault = null;
        this.currentAccount = 0;
        this.wallet = null;
        this.isLocked = true;
        this.connection = null;
        this.qnetConnection = null;
        this.postQuantumKeys = null;
        
        // Initialize connections
        this.initializeConnections();
    }
    
    /**
     * Initialize blockchain connections
     */
    async initializeConnections() {
        try {
            // Solana connection for 1DEV token operations
            this.connection = new Connection(
                process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
                'confirmed'
            );
            
            // QNet connection for native operations
            this.qnetConnection = {
                rpcUrl: process.env.QNET_RPC_URL || 'https://rpc.qnet.network',
                wsUrl: process.env.QNET_WS_URL || 'wss://ws.qnet.network'
            };
        } catch (error) {
            console.error('Failed to initialize connections:', error);
        }
    }
    
    // Create new wallet
    async createWallet(password) {
        try {
            // Generate mnemonic
            const mnemonic = bip39.generateMnemonic(256); // 24 words for extra security
            
            // Derive keys
            const keys = await this.deriveKeysFromMnemonic(mnemonic);
            
            // Generate post-quantum keys
            const pqKeys = await this.generatePostQuantumKeys();
            
            // Create wallet object
            const wallet = {
                mnemonic,
                publicKey: keys.publicKey,
                privateKey: keys.privateKey,
                address: keys.address,
                postQuantumKeys: pqKeys,
                accounts: [{
                    index: 0,
                    name: 'Account 1',
                    publicKey: keys.publicKey,
                    address: keys.address,
                    balance: 0
                }],
                settings: {
                    autoLock: true,
                    lockTimeout: 300000, // 5 minutes
                    currency: 'USD',
                    language: 'en',
                    theme: 'dark'
                },
                createdAt: Date.now()
            };
            
            // Encrypt and store wallet
            await this.encryptAndStoreWallet(wallet, password);
            
            this.wallet = wallet;
            this.isLocked = false;
            
            return {
                address: wallet.address,
                mnemonic: wallet.mnemonic,
                publicKey: wallet.publicKey
            };
        } catch (error) {
            console.error('Failed to create wallet:', error);
            throw new Error('Failed to create wallet');
        }
    }
    
    // Generate mnemonic with 256-bit entropy
    async generateMnemonic() {
        // Generate 256 bits of entropy for 24 words
        const entropy = this.crypto.generateRandomBytes(32);
        
        // Convert to mnemonic using BIP39
        const mnemonic = await this.entropyToMnemonic(entropy);
        
        return mnemonic;
    }
    
    // Convert entropy to mnemonic (BIP39)
    async entropyToMnemonic(entropy) {
        // Load BIP39 wordlist
        const wordlist = await this.loadWordlist();
        
        // Add checksum
        const entropyBits = Array.from(entropy).map(b => b.toString(2).padStart(8, '0')).join('');
        const checksumBits = await this.getChecksum(entropy);
        const bits = entropyBits + checksumBits;
        
        // Split into 11-bit chunks and map to words
        const words = [];
        for (let i = 0; i < bits.length; i += 11) {
            const index = parseInt(bits.slice(i, i + 11), 2);
            words.push(wordlist[index]);
        }
        
        return words.join(' ');
    }
    
    // Calculate checksum for entropy
    async getChecksum(entropy) {
        const hash = await crypto.subtle.digest('SHA-256', entropy);
        const hashBits = Array.from(new Uint8Array(hash))
            .map(b => b.toString(2).padStart(8, '0'))
            .join('');
        
        // Checksum is first (entropy length / 32) bits of hash
        const checksumLength = entropy.length / 4;
        return hashBits.slice(0, checksumLength);
    }
    
    // Convert mnemonic to seed
    async mnemonicToSeed(mnemonic, passphrase = '') {
        const mnemonicBuffer = new TextEncoder().encode(mnemonic);
        const salt = new TextEncoder().encode('mnemonic' + passphrase);
        
        // PBKDF2 with 2048 iterations
        const keyMaterial = await crypto.subtle.importKey(
            'raw',
            mnemonicBuffer,
            'PBKDF2',
            false,
            ['deriveBits']
        );
        
        const seed = await crypto.subtle.deriveBits(
            {
                name: 'PBKDF2',
                salt: salt,
                iterations: 2048,
                hash: 'SHA-512'
            },
            keyMaterial,
            512 // 64 bytes
        );
        
        return new Uint8Array(seed);
    }
    
    // Create HD wallet from seed
    async createHDWallet(seed) {
        // Use HMAC-SHA512 to generate master key
        const hmacKey = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode('Bitcoin seed'),
            { name: 'HMAC', hash: 'SHA-512' },
            false,
            ['sign']
        );
        
        const masterKey = await crypto.subtle.sign('HMAC', hmacKey, seed);
        const masterKeyArray = new Uint8Array(masterKey);
        
        return {
            privateKey: masterKeyArray.slice(0, 32),
            chainCode: masterKeyArray.slice(32)
        };
    }
    
    // Import wallet from mnemonic
    async importWallet(mnemonic, password) {
        try {
            // Validate mnemonic
            if (!bip39.validateMnemonic(mnemonic)) {
                throw new Error('Invalid mnemonic phrase');
            }
            
            // Derive keys
            const keys = await this.deriveKeysFromMnemonic(mnemonic);
            
            // Generate post-quantum keys
            const pqKeys = await this.generatePostQuantumKeys();
            
            // Create wallet object
            const wallet = {
                mnemonic,
                publicKey: keys.publicKey,
                privateKey: keys.privateKey,
                address: keys.address,
                postQuantumKeys: pqKeys,
                accounts: [{
                    index: 0,
                    name: 'Account 1',
                    publicKey: keys.publicKey,
                    address: keys.address,
                    balance: 0
                }],
                settings: {
                    autoLock: true,
                    lockTimeout: 300000,
                    currency: 'USD',
                    language: 'en',
                    theme: 'dark'
                },
                importedAt: Date.now()
            };
            
            // Encrypt and store wallet
            await this.encryptAndStoreWallet(wallet, password);
            
            this.wallet = wallet;
            this.isLocked = false;
            
            return {
                address: wallet.address,
                publicKey: wallet.publicKey
            };
        } catch (error) {
            console.error('Failed to import wallet:', error);
            throw new Error('Failed to import wallet');
        }
    }
    
    // Validate mnemonic phrase
    async validateMnemonic(mnemonic) {
        const words = mnemonic.trim().split(/\s+/);
        
        // Check word count (12, 15, 18, 21, or 24)
        if (![12, 15, 18, 21, 24].includes(words.length)) {
            return false;
        }
        
        // Load wordlist and check all words exist
        const wordlist = await this.loadWordlist();
        for (const word of words) {
            if (!wordlist.includes(word)) {
                return false;
            }
        }
        
        // TODO: Validate checksum
        return true;
    }
    
    // Unlock wallet
    async unlock(password) {
        try {
            const result = await chrome.storage.local.get(['encryptedVault']);
            if (!result.encryptedVault) {
                throw new Error('No wallet found');
            }
            
            const decrypted = CryptoJS.AES.decrypt(result.encryptedVault, password);
            const walletData = JSON.parse(decrypted.toString(CryptoJS.enc.Utf8));
            
            this.wallet = walletData;
            this.isLocked = false;
            
            // Update balances
            await this.updateBalances();
            
            return true;
        } catch (error) {
            console.error('Failed to unlock wallet:', error);
            return false;
        }
    }
    
    // Lock wallet
    async lock() {
        this.wallet = null;
        this.isLocked = true;
    }
    
    // Get current address
    getCurrentAddress() {
        if (!this.wallet) {
            throw new Error('Wallet is locked');
        }
        
        return this.wallet.address;
    }
    
    // Get all accounts
    getAccounts() {
        if (!this.wallet) {
            throw new Error('Wallet is locked');
        }
        
        return this.wallet.accounts.map((account, index) => ({
            index,
            address: account.address,
            name: account.name || `Account ${index + 1}`,
            canActivateNode: account.canActivateNode !== false, // Default true for existing accounts
            nodeConfig: account.nodeConfig || null,
            hasActiveNode: !!account.nodeConfig,
            nodeType: account.nodeConfig?.nodeType || null
        }));
    }

    // Get accounts that can activate nodes
    getAccountsForNodeActivation() {
        if (!this.wallet) {
            throw new Error('Wallet is locked');
        }
        
        return this.wallet.accounts
            .map((account, index) => ({
                index,
                address: account.address,
                name: account.name || `Account ${index + 1}`,
                canActivateNode: account.canActivateNode !== false,
                hasActiveNode: !!account.nodeConfig
            }))
            .filter(account => account.canActivateNode && !account.hasActiveNode);
    }

    // Get accounts with active nodes
    getAccountsWithNodes() {
        if (!this.wallet) {
            throw new Error('Wallet is locked');
        }
        
        return this.wallet.accounts
            .map((account, index) => ({
                index,
                address: account.address,
                name: account.name || `Account ${index + 1}`,
                nodeConfig: account.nodeConfig,
                nodeType: account.nodeConfig?.nodeType,
                activatedAt: account.nodeConfig?.activatedAt
            }))
            .filter(account => account.nodeConfig);
    }
    
    // Add new account
    async addAccount(name) {
        if (!this.wallet) {
            throw new Error('Wallet is locked');
        }
        
        const accountIndex = this.wallet.accounts.length;
        
        // Decrypt HD wallet temporarily
        const password = await this.requestPassword();
        const hdWallet = await this.decryptSensitiveData(this.wallet.hdWallet, password);
        
        const account = await this.deriveAccount(hdWallet, accountIndex);
        account.name = name || `Account ${accountIndex + 1}`;
        account.nodeConfig = null; // No node activated yet
        account.canActivateNode = true; // New address can activate node
        
        // Encrypt private key immediately
        account.privateKey = await this.encryptSensitiveData(account.privateKey, password);
        
        this.wallet.accounts.push(account);
        
        // Save updated wallet
        const fullWallet = {
            ...this.wallet,
            hdWallet: hdWallet,
            accounts: await Promise.all(this.wallet.accounts.map(async (acc) => ({
                ...acc,
                privateKey: acc.privateKey.encrypted ? 
                    await this.decryptSensitiveData(acc.privateKey, password) : 
                    acc.privateKey
            })))
        };
        
        await this.encryptAndStoreWallet(fullWallet, password);
        
        // Clear sensitive data
        this.clearSensitiveData(hdWallet);
        
        return {
            index: account.index,
            address: account.address,
            name: account.name,
            canActivateNode: true
        };
    }

    // Add new account specifically for node activation
    async addAccountForNode(name, nodeType = 'light') {
        if (!this.wallet) {
            throw new Error('Wallet is locked');
        }
        
        // Create new account
        const newAccount = await this.addAccount(name);
        
        return {
            ...newAccount,
            nodeType: nodeType,
            readyForActivation: true,
            message: `New account created for ${nodeType} node activation`
        };
    }
    
    // Switch account
    switchAccount(index) {
        if (!this.wallet) {
            throw new Error('Wallet is locked');
        }
        
        if (index < 0 || index >= this.wallet.accounts.length) {
            throw new Error('Invalid account index');
        }
        
        this.currentAccount = index;
        this.wallet.currentAccount = index;
    }
    
    // Send transaction
    async sendTransaction(to, amount, memo = '', gasPrice = null, gasLimit = null) {
        if (!this.wallet) {
            throw new Error('Wallet is locked');
        }
        
        const account = this.wallet.accounts[this.currentAccount];
        
        // Get recommended gas parameters if not provided
        if (!gasPrice) {
            gasPrice = await this.network.getGasPrice() || 10; // Default 10
        }
        if (!gasLimit) {
            gasLimit = await this.network.estimateGas(account.address, to, amount) || 21000; // Default 21000
        }
        
        // Create transaction
        const tx = {
            from: account.address,
            to,
            amount,
            memo,
            gasPrice,
            gasLimit,
            timestamp: Date.now(),
            nonce: await this.network.getNonce(account.address)
        };
        
        // Request password to decrypt private key
        const password = await this.requestPassword();
        const privateKeyHex = await this.decryptSensitiveData(account.privateKey, password);
        
        // Import private key for Ed25519 signing
        const privateKey = await this.crypto.importPrivateKey(privateKeyHex);
        
        // Sign transaction with Ed25519
        const signature = await this.crypto.signTransaction(tx, privateKey);
        tx.signature = signature;
        
        // Clear private key from memory
        this.clearSensitiveData(privateKeyHex);
        
        // Broadcast transaction
        const txHash = await this.network.broadcastTransaction(tx);
        
        return txHash;
    }
    
    // Sign message
    async signMessage(message) {
        if (!this.wallet) {
            throw new Error('Wallet is locked');
        }
        
        const account = this.wallet.accounts[this.currentAccount];
        
        // Request password to decrypt private key
        const password = await this.requestPassword();
        const privateKeyHex = await this.decryptSensitiveData(account.privateKey, password);
        
        // Import private key for Ed25519 signing
        const privateKey = await this.crypto.importPrivateKey(privateKeyHex);
        
        // Sign message with Ed25519
        const signature = await this.crypto.signMessage(message, privateKey);
        
        // Clear private key from memory
        this.clearSensitiveData(privateKeyHex);
        
        return signature;
    }
    
    // Derive account from HD wallet
    async deriveAccount(hdWallet, index) {
        const path = `m/44'/501'/${index}'/0'`;
        
        // Derive private key using BIP32
        const pathHash = await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(path)
        );
        
        const privateKeyData = new Uint8Array(32);
        for (let i = 0; i < 32; i++) {
            privateKeyData[i] = hdWallet.privateKey[i] ^ new Uint8Array(pathHash)[i];
        }
        
        // Generate Ed25519 key pair
        const keyPair = await this.crypto.generateKeyPair();
        
        // Export keys
        const privateKeyHex = await this.crypto.exportPrivateKey(keyPair.privateKey);
        const publicKeyHex = await this.crypto.exportPublicKey(keyPair.publicKey);
        
        // Generate address from public key
        const address = await this.publicKeyToAddress(publicKeyHex);
        
        return {
            index,
            path,
            address,
            publicKey: publicKeyHex,
            privateKey: privateKeyHex
        };
    }
    
    // Convert public key to QNet address
    async publicKeyToAddress(publicKeyHex) {
        const publicKey = this.crypto.hexToUint8Array(publicKeyHex);
        
        // Hash public key
        const hash = await crypto.subtle.digest('SHA-256', publicKey);
        const hashArray = new Uint8Array(hash);
        
        // Take first 20 bytes and add prefix
        const addressBytes = new Uint8Array(21);
        addressBytes[0] = 0x51; // 'Q' prefix
        addressBytes.set(hashArray.slice(0, 20), 1);
        
        // Encode as base58
        return 'qnet1' + this.base58Encode(addressBytes);
    }
    
    // Export private key (requires password)
    async exportPrivateKey(password) {
        if (!this.wallet) {
            throw new Error('Wallet is locked');
        }
        
        // Verify password
        const result = await chrome.storage.local.get(['encryptedVault']);
        try {
            const decrypted = CryptoJS.AES.decrypt(result.encryptedVault, password);
            const walletData = JSON.parse(decrypted.toString(CryptoJS.enc.Utf8));
            return walletData.privateKey;
        } catch {
            throw new Error('Invalid password');
        }
    }
    
    // Get transaction history
    async getTransactionHistory() {
        if (!this.wallet) {
            throw new Error('Wallet is locked');
        }
        
        const address = this.getCurrentAddress();
        return await this.network.getTransactions(address);
    }
    
    // Get balance
    async getBalance() {
        if (!this.wallet) {
            throw new Error('Wallet is locked');
        }
        
        const address = this.getCurrentAddress();
        return await this.network.getBalance(address);
    }
    
    // Encrypt sensitive data in memory
    async encryptSensitiveData(data, password) {
        const encrypted = await this.crypto.encrypt(data, password);
        return { encrypted: true, data: encrypted };
    }
    
    // Decrypt sensitive data
    async decryptSensitiveData(encryptedData, password) {
        if (!encryptedData.encrypted) {
            return encryptedData;
        }
        return await this.crypto.decrypt(encryptedData.data, password);
    }
    
    // Clear sensitive data from memory
    clearSensitiveData(data) {
        if (typeof data === 'string') {
            // Can't really clear strings in JavaScript
            return;
        }
        
        if (data instanceof Uint8Array) {
            crypto.getRandomValues(data);
        } else if (typeof data === 'object' && data !== null) {
            for (const key in data) {
                if (data[key] instanceof Uint8Array) {
                    crypto.getRandomValues(data[key]);
                }
            }
        }
    }
    
    // Request password from user
    async requestPassword(reason = 'Authentication required') {
        return await passwordPrompt.requestPassword(reason);
    }
    
    // Load BIP39 wordlist
    async loadWordlist() {
        return await bip39Wordlist.loadWordlist();
    }
    
    // Base58 encoding
    base58Encode(bytes) {
        const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
        let encoded = '';
        
        // Convert bytes to big integer
        let num = 0n;
        for (const byte of bytes) {
            num = num * 256n + BigInt(byte);
        }
        
        // Convert to base58
        while (num > 0n) {
            const remainder = num % 58n;
            encoded = alphabet[Number(remainder)] + encoded;
            num = num / 58n;
        }
        
        // Add leading zeros
        for (const byte of bytes) {
            if (byte === 0) {
                encoded = '1' + encoded;
            } else {
                break;
            }
        }
        
        return encoded;
    }
    
    /**
     * Derive keys from mnemonic
     */
    async deriveKeysFromMnemonic(mnemonic) {
        const seed = await bip39.mnemonicToSeed(mnemonic);
        const derivedSeed = derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key;
        const keyPair = nacl.sign.keyPair.fromSeed(derivedSeed);
        
        const publicKey = bs58.encode(keyPair.publicKey);
        const privateKey = bs58.encode(keyPair.secretKey);
        const address = publicKey; // For QNet, address is the public key
        
        return {
            publicKey,
            privateKey,
            address,
            keyPair
        };
    }
    
    /**
     * Generate post-quantum cryptographic keys
     */
    async generatePostQuantumKeys() {
        // Placeholder for post-quantum key generation
        // In production, this would use CRYSTALS-Dilithium and CRYSTALS-KYBER
        return {
            dilithiumKeyPair: {
                publicKey: 'pq_public_key_placeholder',
                privateKey: 'pq_private_key_placeholder'
            },
            kyberKeyPair: {
                publicKey: 'kyber_public_key_placeholder',
                privateKey: 'kyber_private_key_placeholder'
            }
        };
    }
    
    /**
     * Encrypt and store wallet
     */
    async encryptAndStoreWallet(wallet, password) {
        const encrypted = CryptoJS.AES.encrypt(
            JSON.stringify(wallet),
            password
        ).toString();
        
        await chrome.storage.local.set({
            encryptedVault: encrypted,
            walletExists: true
        });
    }
    
    /**
     * Get QNC balance from QNet network
     */
    async getQNCBalance(address) {
        try {
            // Placeholder for QNet RPC call
            // In production, this would call QNet RPC
            const response = await fetch(`${this.qnetConnection.rpcUrl}/balance/${address}`);
            const data = await response.json();
            return data.balance || 0;
        } catch (error) {
            console.error('Failed to get QNC balance:', error);
            return 0;
        }
    }
    
    /**
     * Get Solana balance
     */
    async getSolanaBalance(address) {
        try {
            const publicKey = new PublicKey(address);
            const balance = await this.connection.getBalance(publicKey);
            return balance / LAMPORTS_PER_SOL;
        } catch (error) {
            console.error('Failed to get Solana balance:', error);
            return 0;
        }
    }
    
    /**
     * Update all account balances
     */
    async updateBalances() {
        if (this.isLocked || !this.wallet) return;
        
        for (const account of this.wallet.accounts) {
            const balance = await this.getBalance(account.address);
            account.balance = balance.total;
        }
    }

    /**
     * Activate QNet node by burning 1DEV tokens (Phase 1) or holding QNC (Phase 2)
     */
    async activateNode(nodeType = 'full', accountIndex = null) {
        if (this.isLocked) throw new Error('Wallet is locked');
        
        try {
            // Use specified account or current account
            const targetAccountIndex = accountIndex !== null ? accountIndex : this.currentAccount;
            const targetAccount = this.wallet.accounts[targetAccountIndex];
            
            if (!targetAccount) {
                throw new Error('Invalid account index');
            }
            
            // Check if account already has a node
            if (targetAccount.nodeConfig) {
                throw new Error(`Account "${targetAccount.name}" already has an activated node`);
            }
            
            // Determine current phase
            const currentPhase = await this.getCurrentPhase();
            
            let result;
            if (currentPhase === 1) {
                result = await this.activateNodePhase1(nodeType, targetAccountIndex);
            } else {
                result = await this.activateNodePhase2(nodeType, targetAccountIndex);
            }
            
            // Update account with node configuration
            targetAccount.nodeConfig = {
                nodeType: nodeType,
                activatedAt: Date.now(),
                activationResult: result
            };
            targetAccount.canActivateNode = false; // One node per address
            
            // Save wallet
            await this.saveWallet();
            
            return {
                ...result,
                accountIndex: targetAccountIndex,
                accountName: targetAccount.name,
                accountAddress: targetAccount.address
            };
        } catch (error) {
            console.error('Failed to activate node:', error);
            throw new Error('Node activation failed');
        }
    }

    /**
     * Activate node for specific account address
     */
    async activateNodeForAddress(walletAddress, nodeType = 'light') {
        if (this.isLocked) throw new Error('Wallet is locked');
        
        // Find account by address
        const accountIndex = this.wallet.accounts.findIndex(acc => acc.address === walletAddress);
        
        if (accountIndex === -1) {
            throw new Error(`Account with address ${walletAddress} not found`);
        }
        
        return await this.activateNode(nodeType, accountIndex);
    }

    /**
     * Phase 1: Burn 1DEV tokens for node testing (Node earns QNC via pings)
     * CORRECTED: All node types cost 1500 1DEV (same price)
     */
    async activateNodePhase1(nodeType, accountIndex = null) {
        const targetAccountIndex = accountIndex !== null ? accountIndex : this.currentAccount;
        const targetAccount = this.wallet.accounts[targetAccountIndex];
        const burnAmount = 1500; // Same for ALL node types in Phase 1
        
        // Step 1: Check 1DEV balance
        const devBalance = await this.get1DEVBalance();
        if (devBalance < burnAmount) {
            throw new Error(`Insufficient 1DEV tokens. Need ${burnAmount}, have ${devBalance}`);
        }
        
        // Step 2: Burn 1DEV tokens on Solana (NO QNC received!)
        const burnTx = await this.burn1DEVTokens(burnAmount);
        
        // Step 3: Generate node access proof
        const accessProof = await this.generateNodeAccessProof(burnTx, nodeType);
        
        // Step 4: Register node access in QNet
        const nodeRegistration = await this.registerNodeAccess(accessProof);
        
        return {
            success: true,
            phase: 1,
            burnTransaction: burnTx,
            nodeAccess: nodeRegistration,
            nodeType,
            burnAmount: burnAmount, // 1500 for all types
            qncReceived: 0, // ❌ NO QNC given for activation!
            earningEnabled: true, // ✅ Can earn through pings
            message: 'Node activated! Start earning QNC through network pings every 4 hours.'
        };
    }

    /**
     * Phase 2: Send QNC to Pool #3 for node activation (redistributed to all active nodes)
     * CORRECTED: QNC goes to Pool #3 which distributes rewards to ALL active nodes
     */
    async activateNodePhase2(nodeType, accountIndex = null) {
        const targetAccountIndex = accountIndex !== null ? accountIndex : this.currentAccount;
        const targetAccount = this.wallet.accounts[targetAccountIndex];
        // Get current network size for dynamic pricing
        const networkStats = await this.getNetworkStats();
        const totalNodes = networkStats.totalActiveNodes;
        
        // Calculate dynamic price based on network size
        const baseRequirements = {
            light: 5000,   // Base: 5,000 QNC
            full: 7500,    // Base: 7,500 QNC
            super: 10000   // Base: 10,000 QNC
        };
        
        // Network size multipliers (production implementation)
        let multiplier;
        if (totalNodes < 100000) {
            multiplier = 0.5; // Early network discount
        } else if (totalNodes < 1000000) {
            multiplier = 1.0; // Standard pricing
        } else if (totalNodes < 10000000) {
            multiplier = 2.0; // High demand
        } else {
            multiplier = 3.0; // Mature network
        }
        
        const requiredQNC = Math.floor(baseRequirements[nodeType] * multiplier);
        
        // Step 1: Check QNC balance
        const qncBalance = await this.getQNCBalance();
        if (qncBalance < requiredQNC) {
            throw new Error(`Insufficient QNC for activation. Need ${requiredQNC}, have ${qncBalance}`);
        }
        
        // Step 2: Send QNC to Pool #3 (redistributed to ALL active nodes as rewards!)
        const pool3Tx = await this.sendQNCToPool3(requiredQNC, nodeType);
        
        // Step 3: Generate activation code (simple, no NFT)
        const activationCode = this.generateActivationCode(pool3Tx, nodeType);
        
        // Step 4: Register node in QNet with activation code
        const nodeRegistration = await this.registerNodeWithCode(activationCode, nodeType);
        
        return {
            success: true,
            phase: 2,
            pool3Transaction: pool3Tx,
            activationCode: activationCode,
            nodeRegistration: nodeRegistration,
            nodeType,
            qncSentToPool3: requiredQNC,
            networkSize: totalNodes,
            priceMultiplier: multiplier,
            message: `Node activated! Sent ${requiredQNC} QNC to Pool #3. All active nodes benefit from rewards distribution.`
        };
    }

    /**
     * Get current system phase
     */
    async getCurrentPhase() {
        try {
            const response = await fetch(`${this.qnetConnection.rpcUrl}/system/phase`);
            const data = await response.json();
            return data.currentPhase; // 1 or 2
        } catch (error) {
            console.error('Failed to get current phase:', error);
            return 1; // Default to Phase 1
        }
    }

    /**
     * Get 1DEV token balance on Solana
     */
    async get1DEVBalance() {
        try {
            // Implementation for checking 1DEV SPL token balance
            const response = await fetch(`${this.solanaConnection}/balance/1dev/${this.wallet.address}`);
            const data = await response.json();
            return data.balance || 0;
        } catch (error) {
            console.error('Failed to get 1DEV balance:', error);
            return 0;
        }
    }

    /**
     * Burn 1DEV tokens on Solana (Phase 1 only)
     */
    async burn1DEVTokens(amount) {
        // Create burn transaction on Solana
        const burnTransaction = {
            from: this.wallet.address,
            to: '11111111111111111111111111111111', // Burn address
            token: '1DEV',
            amount,
            type: 'burn',
            timestamp: Date.now()
        };
        
        // Sign and broadcast to Solana
        const signature = await this.signTransactionPQ(burnTransaction);
        burnTransaction.signature = signature;
        
        const txHash = await this.broadcastToSolana(burnTransaction);
        
        return {
            txHash,
            amount,
            token: '1DEV',
            type: 'burn',
            timestamp: Date.now()
        };
    }

    /**
     * Generate node access proof from burn transaction
     */
    async generateNodeAccessProof(burnTx, nodeType) {
        const proof = {
            burnTxHash: burnTx.txHash,
            nodeType,
            userAddress: this.wallet.address,
            timestamp: Date.now(),
            phase: 1
        };
        
        // Create cryptographic proof
        const proofSignature = await this.signTransactionPQ(proof);
        proof.signature = proofSignature;
        
        return proof;
    }

    /**
     * Register node access in QNet (Phase 1)
     */
    async registerNodeAccess(accessProof) {
        try {
            const response = await fetch(`${this.qnetConnection.rpcUrl}/node/register/phase1`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(accessProof)
            });
            
            const result = await response.json();
            return result;
        } catch (error) {
            console.error('Failed to register node access:', error);
            throw new Error('Node registration failed');
        }
    }

    /**
     * Register node with hold requirement (Phase 2)
     */
    async registerNodeWithHoldRequirement(nodeType, requiredHold) {
        const registration = {
            nodeType,
            userAddress: this.wallet.address,
            requiredHold,
            phase: 2,
            mechanism: 'HOLD',
            timestamp: Date.now()
        };
        
        try {
            const response = await fetch(`${this.qnetConnection.rpcUrl}/node/register/phase2`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(registration)
            });
            
            const result = await response.json();
            return result;
        } catch (error) {
            console.error('Failed to register node with hold requirement:', error);
            throw new Error('Node registration failed');
        }
    }

    /**
     * Get QNC balance
     */
    async getQNCBalance() {
        try {
            const response = await fetch(`${this.qnetConnection.rpcUrl}/balance/qnc/${this.wallet.address}`);
            const data = await response.json();
            return data.balance || 0;
        } catch (error) {
            console.error('Failed to get QNC balance:', error);
            return 0;
        }
    }

    /**
     * Send QNC to Pool #3 (Phase 2 activation - benefits ALL active nodes)
     */
    async sendQNCToPool3(amount, nodeType) {
        const pool3Transaction = {
            from: this.wallet.address,
            to: 'POOL_3_ADDRESS', // Special Pool #3 address for reward distribution
            token: 'QNC',
            amount,
            pool: 3,
            purpose: 'node_activation',
            nodeType,
            redistributionEnabled: true, // Enables reward distribution to all active nodes
            type: 'pool3_deposit',
            timestamp: Date.now()
        };
        
        // Sign transaction with post-quantum security
        const signature = await this.signTransactionPQ(pool3Transaction);
        pool3Transaction.signature = signature;
        
        // Broadcast to QNet network
        const txHash = await this.broadcastToQNet(pool3Transaction);
        
        return {
            txHash,
            amount,
            pool: 3,
            token: 'QNC',
            type: 'pool3_deposit',
            redistributionEnabled: true,
            allNodesReceiveBenefits: true,
            timestamp: Date.now()
        };
    }

    /**
     * Set token filter to show only specific tokens (e.g., only 1DEV)
     */
    async setTokenFilter(allowedTokens = ['1DEV']) {
        if (!this.wallet) {
            throw new Error('Wallet is locked');
        }
        
        this.wallet.settings.tokenFilter = allowedTokens;
        await this.saveWalletSettings();
        
        // Refresh balances with filter applied
        await this.updateFilteredBalances();
    }

    /**
     * Get filtered token balances (only show allowed tokens)
     */
    async getFilteredBalances() {
        const allowedTokens = this.wallet?.settings?.tokenFilter || ['1DEV'];
        const balances = {};
        
        // Get 1DEV balance from Solana
        if (allowedTokens.includes('1DEV')) {
            balances['1DEV'] = await this.get1DEVBalance();
        }
        
        // Add QNC balance from QNet (always shown)
        balances['QNC'] = await this.getQNCBalance();
        
        return balances;
    }

    /**
     * Update filtered balances and hide other Solana tokens
     */
    async updateFilteredBalances() {
        try {
            const filteredBalances = await this.getFilteredBalances();
            
            // Update wallet balance display
            if (this.wallet) {
                this.wallet.filteredBalances = filteredBalances;
                this.wallet.displayBalances = filteredBalances; // Only show filtered tokens
            }
            
            // Hide all other Solana tokens
            await this.hideSolanaTokens();
            
        } catch (error) {
            console.error('Failed to update filtered balances:', error);
        }
    }

    /**
     * Hide all Solana tokens except allowed ones
     */
    async hideSolanaTokens() {
        const allowedTokens = this.wallet?.settings?.tokenFilter || ['1DEV'];
        
        // This would integrate with Solana wallet to hide unwanted tokens
        // For now, we just track what should be visible
        console.log(`🔍 Filtering tokens: showing only ${allowedTokens.join(', ')}`);
    }

    /**
     * One-click node activation with automatic burn
     */
    async activateNodeOneClick(nodeType = 'light') {
        if (!this.wallet) {
            throw new Error('Wallet is locked');
        }

        try {
            // Check 1DEV balance
            const balance1DEV = await this.get1DEVBalance();
            const required = this.getRequiredBurnAmount(nodeType);
            
            if (balance1DEV < required) {
                throw new Error(`Insufficient 1DEV balance. Have: ${balance1DEV}, Need: ${required}`);
            }

            // Step 1: Burn 1DEV tokens automatically
            console.log('🔥 Step 1: Burning 1DEV tokens...');
            const burnResult = await this.burn1DEVTokens(required);
            
            // Step 2: Submit activation request to QNet
            console.log('📡 Step 2: Submitting activation request...');
            const activationResult = await this.submitActivationRequest({
                nodeType,
                burnTxHash: burnResult.txHash,
                walletAddress: this.wallet.address,
                nodePublicKey: this.wallet.publicKey
            });
            
            // Step 3: Configure node automatically
            console.log('⚙️ Step 3: Configuring node...');
            await this.setupNodeConfiguration(activationResult);
            
            return {
                success: true,
                nodeId: activationResult.nodeId,
                nodeType,
                burnTxHash: burnResult.txHash,
                activationCode: activationResult.activationCode,
                message: `Node activated successfully! Type: ${nodeType}, ID: ${activationResult.nodeId}`
            };

        } catch (error) {
            console.error('One-click activation failed:', error);
            throw error;
        }
    }

    /**
     * Get required burn amount for node type
     */
    getRequiredBurnAmount(nodeType) {
        // These would be fetched from smart contract in production
        const requirements = {
            'light': 1500,
            'full': 1500, 
            'super': 1500
        };
        return requirements[nodeType] || 1500;
    }

    /**
     * Submit activation request to QNet API
     */
    async submitActivationRequest(data) {
        try {
            const response = await fetch(`${this.qnetConnection.rpcUrl}/api/request_activation_token`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    solana_pubkey_user: this.wallet.address,
                    solana_txid: data.burnTxHash,
                    qnet_pubkey: data.nodePublicKey,
                    node_type: data.nodeType,
                    solana_signature_user: await this.signActivationMessage(data),
                    signed_message_user: this.createActivationMessage(data)
                })
            });

            const result = await response.json();
            
            if (!result.success) {
                throw new Error(result.error || 'Activation request failed');
            }

            return result;
        } catch (error) {
            console.error('Failed to submit activation request:', error);
            throw error;
        }
    }

    /**
     * Create activation message for signing
     */
    createActivationMessage(data) {
        return `QNET_ACTIVATION_REQUEST_2025:${data.nodeType}:${data.burnTxHash}:${Date.now()}`;
    }

    /**
     * Sign activation message
     */
    async signActivationMessage(data) {
        const message = this.createActivationMessage(data);
        return await this.signMessage(message);
    }

    /**
     * Setup node configuration automatically
     */
    async setupNodeConfiguration(activationResult) {
        try {
            // Create node configuration
            const nodeConfig = {
                nodeId: activationResult.nodeId,
                nodeType: activationResult.nodeType,
                activationCode: activationResult.activationCode,
                certificate: activationResult.certificate,
                walletAddress: this.wallet.address,
                activatedAt: Date.now(),
                status: 'active'
            };

            // Save to storage
            await this.storage.save('nodeConfig', nodeConfig);
            
            // Update wallet with node info
            this.wallet.nodeConfig = nodeConfig;
            await this.saveWalletSettings();

            console.log('✅ Node configuration saved successfully');
            return nodeConfig;
        } catch (error) {
            console.error('Failed to setup node configuration:', error);
            throw error;
        }
    }

    /**
     * Save wallet settings
     */
    async saveWalletSettings() {
        if (!this.wallet) return;
        
        try {
            // Re-encrypt and save wallet
            const password = await this.getCurrentPassword(); // This would need to be implemented
            await this.encryptAndStoreWallet(this.wallet, password);
        } catch (error) {
            console.error('Failed to save wallet settings:', error);
        }
    }
} 