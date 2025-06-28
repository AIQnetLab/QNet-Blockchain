/**
 * QNet Dual Wallet - Main Integration Class
 * Combines all components for complete dual-network wallet functionality
 */

import { EONAddressGenerator } from '../crypto/EONAddressGenerator.js';
import { DualNetworkManager } from '../network/DualNetworkManager.js';
import { SolanaIntegration } from '../integration/SolanaIntegration.js';
import { QNetIntegration } from '../integration/QNetIntegration.js';
import { ActivationBridgeClient } from '../integration/ActivationBridgeClient.js';
import { NodeOwnershipManager } from '../security/NodeOwnershipManager.js';
import { SingleNodeEnforcement } from '../security/SingleNodeEnforcement.js';
import { SecureCrypto } from '../crypto/SecureCrypto.js';
import { StorageManager } from '../storage/StorageManager.js';

export class QNetDualWallet {
    constructor(i18n) {
        this.i18n = i18n;
        this.initialized = false;
        this.locked = true;
        
        // Core components
        this.eonGenerator = new EONAddressGenerator();
        this.crypto = new SecureCrypto();
        this.storage = new StorageManager();
        
        // Network components
        this.networkManager = new DualNetworkManager();
        this.solanaIntegration = new SolanaIntegration(this.networkManager);
        this.qnetIntegration = new QNetIntegration(this.networkManager);
        this.bridgeClient = new ActivationBridgeClient(this.networkManager);
        
        // Security components
        this.ownershipManager = new NodeOwnershipManager(this.qnetIntegration, this.crypto);
        this.enforcement = new SingleNodeEnforcement(this.qnetIntegration, this.ownershipManager);
        
        // Wallet state
        this.walletData = {
            networks: {
                solana: {
                    address: null,
                    privateKey: null,
                    balances: { SOL: 0, '1DEV': 0 }
                },
                qnet: {
                    address: null,
                    privateKey: null,
                    balances: { QNC: 0 },
                    activeNode: null
                }
            },
            currentNetwork: 'solana',
            phase: 1,
            created: null,
            lastUsed: null
        };

        this.listeners = new Set();
    }

    /**
     * Initialize dual wallet
     */
    async initialize() {
        try {
            console.log('Initializing QNet Dual Wallet...');

            // Initialize storage
            await this.storage.initialize();

            // Initialize network manager
            await this.networkManager.initialize();

            // Initialize integrations
            await this.solanaIntegration.initialize();
            await this.qnetIntegration.initialize();

            // Load existing wallet if available
            await this.loadWallet();

            this.initialized = true;
            console.log('QNet Dual Wallet initialized successfully');

            this.notifyListeners('initialized', { success: true });

        } catch (error) {
            console.error('Failed to initialize dual wallet:', error);
            throw error;
        }
    }

    /**
     * Create new dual wallet
     */
    async createWallet(password, seedPhrase = null) {
        try {
            if (!this.initialized) {
                throw new Error('Wallet not initialized');
            }

            // Generate or use provided seed phrase
            let mnemonic;
            if (seedPhrase) {
                mnemonic = seedPhrase;
            } else {
                mnemonic = this.crypto.generateMnemonic();
            }

            // Validate mnemonic
            if (!this.crypto.validateMnemonic(mnemonic)) {
                throw new Error('Invalid mnemonic phrase');
            }

            // Generate Solana wallet
            const solanaWallet = await this.generateSolanaWallet(mnemonic);
            
            // Generate QNet wallet with EON address
            const qnetWallet = await this.generateQNetWallet(mnemonic);

            // Create wallet data structure
            this.walletData = {
                networks: {
                    solana: {
                        address: solanaWallet.address,
                        privateKey: solanaWallet.privateKey,
                        balances: { SOL: 0, '1DEV': 0 },
                        purpose: 'Phase 1 activation (1DEV burn)'
                    },
                    qnet: {
                        address: qnetWallet.address,
                        privateKey: qnetWallet.privateKey,
                        balances: { QNC: 0 },
                        activeNode: null,
                        purpose: 'Node management + Phase 2 activation'
                    }
                },
                currentNetwork: 'solana',
                phase: 1,
                created: Date.now(),
                lastUsed: Date.now(),
                mnemonic: mnemonic
            };

            // Encrypt and store wallet
            await this.saveWallet(password);

            // Update balances
            await this.updateAllBalances();

            this.locked = false;
            this.notifyListeners('walletCreated', { 
                solanaAddress: solanaWallet.address,
                qnetAddress: qnetWallet.address 
            });

            return {
                success: true,
                mnemonic: mnemonic,
                addresses: {
                    solana: solanaWallet.address,
                    qnet: qnetWallet.address
                }
            };

        } catch (error) {
            console.error('Failed to create wallet:', error);
            throw error;
        }
    }

    /**
     * Generate Solana wallet from mnemonic
     */
    async generateSolanaWallet(mnemonic) {
        try {
            // Use Solana derivation path: m/44'/501'/0'/0'
            const seed = await this.crypto.mnemonicToSeed(mnemonic);
            const keypair = this.crypto.deriveKeypair(seed, "m/44'/501'/0'/0'");
            
            return {
                address: keypair.publicKey.toString(),
                privateKey: Array.from(keypair.secretKey),
                derivationPath: "m/44'/501'/0'/0'"
            };

        } catch (error) {
            console.error('Failed to generate Solana wallet:', error);
            throw error;
        }
    }

    /**
     * Generate QNet wallet with EON address
     */
    async generateQNetWallet(mnemonic) {
        try {
            // Generate deterministic EON address from mnemonic
            const eonAddress = await this.eonGenerator.generateDeterministicEON(mnemonic, 0);
            
            // Generate QNet private key from mnemonic
            const seed = await this.crypto.mnemonicToSeed(mnemonic);
            const privateKey = this.crypto.derivePrivateKey(seed, 'qnet', 0);
            
            return {
                address: eonAddress,
                privateKey: privateKey,
                derivationPath: 'qnet/0'
            };

        } catch (error) {
            console.error('Failed to generate QNet wallet:', error);
            throw error;
        }
    }

    /**
     * Unlock wallet with password
     */
    async unlockWallet(password) {
        try {
            const encryptedData = await this.storage.get('wallet_data');
            if (!encryptedData) {
                throw new Error('No wallet found');
            }

            // Decrypt wallet data
            const decryptedData = await this.crypto.decrypt(encryptedData, password);
            this.walletData = JSON.parse(decryptedData);

            // Update last used timestamp
            this.walletData.lastUsed = Date.now();
            await this.saveWallet(password);

            this.locked = false;
            this.notifyListeners('walletUnlocked', { 
                addresses: {
                    solana: this.walletData.networks.solana.address,
                    qnet: this.walletData.networks.qnet.address
                }
            });

            // Update balances
            await this.updateAllBalances();

            return { success: true };

        } catch (error) {
            console.error('Failed to unlock wallet:', error);
            throw new Error('Invalid password or corrupted wallet data');
        }
    }

    /**
     * Lock wallet
     */
    lockWallet() {
        this.locked = true;
        
        // Clear sensitive data from memory
        if (this.walletData.mnemonic) {
            delete this.walletData.mnemonic;
        }
        
        this.notifyListeners('walletLocked', {});
    }

    /**
     * Import wallet from mnemonic
     */
    async importWallet(mnemonic, password) {
        try {
            if (!this.crypto.validateMnemonic(mnemonic)) {
                throw new Error('Invalid mnemonic phrase');
            }

            return await this.createWallet(password, mnemonic);

        } catch (error) {
            console.error('Failed to import wallet:', error);
            throw error;
        }
    }

    /**
     * Switch between networks
     */
    async switchNetwork(network) {
        try {
            if (this.locked) {
                throw new Error('Wallet is locked');
            }

            if (network === 'solana') {
                await this.networkManager.switchToSolana();
            } else if (network === 'qnet') {
                await this.networkManager.switchToQNet();
            } else {
                throw new Error(`Unknown network: ${network}`);
            }

            this.walletData.currentNetwork = network;
            this.notifyListeners('networkSwitched', { network });

            // Update balances for current network
            await this.updateNetworkBalances(network);

        } catch (error) {
            console.error('Failed to switch network:', error);
            throw error;
        }
    }

    /**
     * Get current wallet state
     */
    getWalletState() {
        if (this.locked) {
            return { locked: true };
        }

        return {
            locked: false,
            initialized: this.initialized,
            currentNetwork: this.walletData.currentNetwork,
            phase: this.walletData.phase,
            addresses: {
                solana: this.walletData.networks.solana.address,
                qnet: this.walletData.networks.qnet.address
            },
            balances: {
                solana: this.walletData.networks.solana.balances,
                qnet: this.walletData.networks.qnet.balances
            },
            activeNode: this.walletData.networks.qnet.activeNode,
            created: this.walletData.created,
            lastUsed: this.walletData.lastUsed
        };
    }

    /**
     * Activate node (Phase 1 - 1DEV burn)
     */
    async activateNodePhase1(nodeType) {
        try {
            if (this.locked) {
                throw new Error('Wallet is locked');
            }

            // Check node limit enforcement
            await this.enforcement.enforceBeforeActivation(
                this.walletData.networks.qnet.address,
                'phase1'
            );

            // Switch to Solana network
            await this.switchNetwork('solana');

            // Get current pricing
            const pricing = await this.solanaIntegration.getCurrentBurnPricing(nodeType);

            // Execute burn transaction
            const solanaKeypair = this.getSolanaKeypair();
            const burnResult = await this.solanaIntegration.burnOneDevForNodeActivation(
                solanaKeypair,
                nodeType,
                pricing.cost,
                this.walletData.networks.qnet.address
            );

            // Request activation code from bridge
            const bridgeResult = await this.bridgeClient.requestActivationToken(
                burnResult,
                nodeType,
                this.walletData.networks.qnet.address,
                this.walletData.networks.solana.address
            );

            // Switch to QNet network
            await this.switchNetwork('qnet');

            // Activate node in QNet
            const activationResult = await this.qnetIntegration.activateNodeWithCode(
                bridgeResult.activationCode,
                this.walletData.networks.qnet.address
            );

            // Update wallet state
            this.walletData.networks.qnet.activeNode = {
                code: bridgeResult.activationCode,
                nodeId: activationResult.nodeId,
                type: nodeType,
                status: 'active',
                activatedAt: activationResult.activatedAt,
                phase: 1,
                burnTxHash: burnResult.signature,
                qnetTxHash: activationResult.txHash
            };

            await this.saveWallet();
            this.notifyListeners('nodeActivated', {
                phase: 1,
                nodeType,
                activationCode: bridgeResult.activationCode
            });

            return {
                success: true,
                activationCode: bridgeResult.activationCode,
                nodeId: activationResult.nodeId
            };

        } catch (error) {
            console.error('Failed to activate node (Phase 1):', error);
            throw error;
        }
    }

    /**
     * Activate node (Phase 2 - QNC to Pool 3)
     */
    async activateNodePhase2(nodeType) {
        try {
            if (this.locked) {
                throw new Error('Wallet is locked');
            }

            // Check node limit enforcement
            await this.enforcement.enforceBeforeActivation(
                this.walletData.networks.qnet.address,
                'phase2'
            );

            // Switch to QNet network
            await this.switchNetwork('qnet');

            // Get activation costs
            const costs = await this.qnetIntegration.getActivationCosts();
            const cost = costs[nodeType];

            // Check QNC balance
            const qncBalance = this.walletData.networks.qnet.balances.QNC;
            if (qncBalance < cost) {
                throw new Error(`Insufficient QNC balance. Required: ${cost}, Available: ${qncBalance}`);
            }

            // Execute QNC activation
            const qnetPrivateKey = this.getQNetPrivateKey();
            const activationResult = await this.qnetIntegration.activateNodeWithQNC(
                nodeType,
                cost,
                this.walletData.networks.qnet.address,
                qnetPrivateKey
            );

            // Update wallet state
            this.walletData.networks.qnet.activeNode = {
                nodeId: activationResult.nodeId,
                type: nodeType,
                status: 'active',
                activatedAt: activationResult.activatedAt,
                phase: 2,
                qncUsed: cost,
                poolTxHash: activationResult.poolTxHash,
                qnetTxHash: activationResult.txHash
            };

            // Update QNC balance
            this.walletData.networks.qnet.balances.QNC -= cost;

            await this.saveWallet();
            this.notifyListeners('nodeActivated', {
                phase: 2,
                nodeType,
                qncUsed: cost
            });

            return {
                success: true,
                nodeId: activationResult.nodeId,
                qncUsed: cost
            };

        } catch (error) {
            console.error('Failed to activate node (Phase 2):', error);
            throw error;
        }
    }

    /**
     * Transfer node ownership
     */
    async transferNode(toAddress) {
        try {
            if (this.locked) {
                throw new Error('Wallet is locked');
            }

            if (!this.walletData.networks.qnet.activeNode) {
                throw new Error('No active node to transfer');
            }

            const activeNode = this.walletData.networks.qnet.activeNode;
            const fromAddress = this.walletData.networks.qnet.address;
            const privateKey = this.getQNetPrivateKey();

            // Validate transfer
            await this.enforcement.validateNodeTransfer(
                fromAddress,
                toAddress,
                activeNode.code || activeNode.nodeId
            );

            // Execute transfer
            const transferResult = await this.ownershipManager.transferNode(
                activeNode.code || activeNode.nodeId,
                fromAddress,
                toAddress,
                privateKey
            );

            // Update wallet state
            this.walletData.networks.qnet.activeNode = null;

            await this.saveWallet();
            this.notifyListeners('nodeTransferred', {
                to: toAddress,
                txHash: transferResult.txHash
            });

            return transferResult;

        } catch (error) {
            console.error('Failed to transfer node:', error);
            throw error;
        }
    }

    /**
     * Update all balances
     */
    async updateAllBalances() {
        try {
            await Promise.all([
                this.updateNetworkBalances('solana'),
                this.updateNetworkBalances('qnet')
            ]);
        } catch (error) {
            console.error('Failed to update balances:', error);
        }
    }

    /**
     * Update network-specific balances
     */
    async updateNetworkBalances(network) {
        try {
            if (network === 'solana') {
                const address = this.walletData.networks.solana.address;
                
                const solBalance = await this.solanaIntegration.getSOLBalance(address);
                const oneDevBalance = await this.solanaIntegration.getOneDevBalance(address);
                
                this.walletData.networks.solana.balances = {
                    SOL: solBalance,
                    '1DEV': oneDevBalance
                };
                
            } else if (network === 'qnet') {
                const address = this.walletData.networks.qnet.address;
                
                const qncBalance = await this.qnetIntegration.getQNCBalance(address);
                
                this.walletData.networks.qnet.balances = {
                    QNC: qncBalance
                };
            }

            this.notifyListeners('balancesUpdated', { network });

        } catch (error) {
            console.error(`Failed to update ${network} balances:`, error);
        }
    }

    /**
     * Get Solana keypair
     */
    getSolanaKeypair() {
        if (this.locked) {
            throw new Error('Wallet is locked');
        }

        const privateKeyArray = this.walletData.networks.solana.privateKey;
        return this.crypto.keypairFromSecretKey(new Uint8Array(privateKeyArray));
    }

    /**
     * Get QNet private key
     */
    getQNetPrivateKey() {
        if (this.locked) {
            throw new Error('Wallet is locked');
        }

        return this.walletData.networks.qnet.privateKey;
    }

    /**
     * Save wallet to storage
     */
    async saveWallet(password = null) {
        try {
            if (password) {
                const encryptedData = await this.crypto.encrypt(
                    JSON.stringify(this.walletData),
                    password
                );
                await this.storage.set('wallet_data', encryptedData);
            } else {
                // Update existing encrypted wallet
                const existingData = await this.storage.get('wallet_data');
                if (existingData) {
                    // This would require storing the password or re-encrypting
                    // For now, we'll just update the timestamp
                    this.walletData.lastUsed = Date.now();
                }
            }
        } catch (error) {
            console.error('Failed to save wallet:', error);
            throw error;
        }
    }

    /**
     * Load wallet from storage
     */
    async loadWallet() {
        try {
            const encryptedData = await this.storage.get('wallet_data');
            if (encryptedData) {
                // Wallet exists but is encrypted - user needs to unlock
                this.locked = true;
                return { walletExists: true, locked: true };
            } else {
                // No wallet exists
                return { walletExists: false };
            }
        } catch (error) {
            console.error('Failed to load wallet:', error);
            return { walletExists: false };
        }
    }

    /**
     * Export wallet data
     */
    exportWallet() {
        if (this.locked) {
            throw new Error('Wallet is locked');
        }

        return {
            mnemonic: this.walletData.mnemonic,
            addresses: {
                solana: this.walletData.networks.solana.address,
                qnet: this.walletData.networks.qnet.address
            },
            created: this.walletData.created
        };
    }

    /**
     * Add event listener
     */
    addListener(callback) {
        this.listeners.add(callback);
    }

    /**
     * Remove event listener
     */
    removeListener(callback) {
        this.listeners.delete(callback);
    }

    /**
     * Notify listeners
     */
    notifyListeners(event, data) {
        for (const listener of this.listeners) {
            try {
                listener(event, data);
            } catch (error) {
                console.error('Listener error:', error);
            }
        }
    }

    /**
     * Get wallet statistics
     */
    getWalletStats() {
        return {
            initialized: this.initialized,
            locked: this.locked,
            networks: Object.keys(this.walletData.networks),
            currentNetwork: this.walletData.currentNetwork,
            phase: this.walletData.phase,
            hasActiveNode: !!this.walletData.networks.qnet.activeNode,
            created: this.walletData.created,
            lastUsed: this.walletData.lastUsed
        };
    }

    /**
     * Destroy wallet (remove all data)
     */
    async destroyWallet() {
        try {
            await this.storage.remove('wallet_data');
            this.walletData = {};
            this.locked = true;
            this.initialized = false;
            
            this.notifyListeners('walletDestroyed', {});
            
        } catch (error) {
            console.error('Failed to destroy wallet:', error);
            throw error;
        }
    }
} 