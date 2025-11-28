/**
 * QNet Dual Wallet - Main Integration Class
 * Combines all components for complete dual-network wallet functionality
 * Updated with production-ready configuration and error handling
 */

import { EONAddressGenerator } from '../crypto/EONAddressGenerator.js';
import { DualNetworkManager } from '../network/DualNetworkManager.js';
import { SolanaIntegration } from '../integration/SolanaIntegration.js';
import { QNetIntegration } from '../integration/QNetIntegration.js';
import { ActivationBridgeClient } from '../integration/ActivationBridgeClient.js';
import { ProductionBridgeClient } from '../integration/ProductionBridgeClient.js';
import { NetworkConfig } from '../config/NetworkConfig.js';
import { NodeOwnershipManager } from '../security/NodeOwnershipManager.js';
import { SingleNodeEnforcement } from '../security/SingleNodeEnforcement.js';
import { SecureCrypto } from '../crypto/SecureCrypto.js';
import { StorageManager } from '../storage/StorageManager.js';

export class QNetDualWallet {
    constructor(i18n) {
        this.i18n = i18n;
        this.initialized = false;
        this.locked = true;
        
        // Production configuration
        this.networkConfig = new NetworkConfig();
        this.environment = this.networkConfig.getEnvironment();
        this.isProduction = this.networkConfig.isProduction();
        
        // Core components
        this.eonGenerator = new EONAddressGenerator();
        this.crypto = new SecureCrypto();
        this.storage = new StorageManager();
        
        // Network components with production config
        this.networkManager = new DualNetworkManager();
        this.solanaIntegration = new SolanaIntegration(this.networkManager);
        this.qnetIntegration = new QNetIntegration(this.networkManager);
        
        // Use production bridge client in production environment
        this.bridgeClient = this.isProduction ? 
            new ProductionBridgeClient(this.networkManager) :
            new ActivationBridgeClient(this.networkManager);
        
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
            lastUsed: null,
            environment: this.environment
        };

        this.listeners = new Set();
        this.healthCheckInterval = null;
        this.balanceUpdateInterval = null;
    }

    /**
     * Initialize dual wallet with production configuration
     */
    async initialize() {
        try {
            console.log(`Initializing QNet Dual Wallet (${this.environment})...`);

            // Validate network configuration
            const configValidation = this.networkConfig.validateConfig();
            if (!configValidation.valid) {
                throw new Error(`Invalid configuration: ${configValidation.errors.join(', ')}`);
            }

            // Initialize storage
            await this.storage.initialize();

            // Initialize network manager with production config
            await this.networkManager.initialize();
            this.applyNetworkConfiguration();

            // Initialize integrations
            await this.solanaIntegration.initialize();
            await this.qnetIntegration.initialize();

            // Initialize production bridge client
            if (this.isProduction) {
                await this.bridgeClient.init();
            }

            // Load existing wallet if available
            await this.loadWallet();

            // Start health monitoring
            this.startHealthMonitoring();

            this.initialized = true;
            console.log(`QNet Dual Wallet initialized successfully (${this.environment})`);

            this.notifyListeners('initialized', { 
                success: true, 
                environment: this.environment,
                isProduction: this.isProduction
            });

        } catch (error) {
            console.error('Failed to initialize dual wallet:', error);
            this.notifyListeners('initializationFailed', { error: error.message });
            throw error;
        }
    }

    /**
     * Apply network configuration to components
     */
    applyNetworkConfiguration() {
        const solanaConfig = this.networkConfig.getSolanaConfig();
        const qnetConfig = this.networkConfig.getQNetConfig();
        const bridgeConfig = this.networkConfig.getBridgeConfig();

        // Update network manager with production URLs
        this.networkManager.updateNetworkConfig('solana', {
            rpc: solanaConfig.rpc,
            wsRpc: solanaConfig.wsRpc,
            timeout: solanaConfig.timeout
        });

        this.networkManager.updateNetworkConfig('qnet', {
            rpc: qnetConfig.rpc,
            wsRpc: qnetConfig.wsRpc,
            timeout: qnetConfig.timeout
        });

        // Update bridge client URL
        if (this.bridgeClient.setBridgeUrl) {
            this.bridgeClient.setBridgeUrl(bridgeConfig.url);
        }
    }

    /**
     * Create new dual wallet with enhanced validation
     */
    async createWallet(password, seedPhrase = null) {
        try {
            if (!this.initialized) {
                throw new Error('Wallet not initialized');
            }

            // Validate password strength
            this.validatePasswordStrength(password);

            // Generate or use provided seed phrase
            let mnemonic;
            if (seedPhrase) {
                mnemonic = seedPhrase.trim();
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

            // Create wallet data structure with environment info
            this.walletData = {
                networks: {
                    solana: {
                        address: solanaWallet.address,
                        privateKey: solanaWallet.privateKey,
                        balances: { SOL: 0, '1DEV': 0 },
                        purpose: 'Phase 1 activation (1DEV burn)',
                        derivationPath: solanaWallet.derivationPath
                    },
                    qnet: {
                        address: qnetWallet.address,
                        privateKey: qnetWallet.privateKey,
                        balances: { QNC: 0 },
                        activeNode: null,
                        purpose: 'Node management + Phase 2 activation',
                        derivationPath: qnetWallet.derivationPath
                    }
                },
                currentNetwork: 'solana',
                phase: 1,
                created: Date.now(),
                lastUsed: Date.now(),
                mnemonic: mnemonic,
                environment: this.environment,
                version: '1.0.0'
            };

            // Encrypt and store wallet
            await this.saveWallet(password);

            // Update balances
            await this.updateAllBalances();

            // Start periodic updates
            this.startPeriodicUpdates();

            this.locked = false;
            this.notifyListeners('walletCreated', { 
                solanaAddress: solanaWallet.address,
                qnetAddress: qnetWallet.address,
                environment: this.environment
            });

            return {
                success: true,
                mnemonic: mnemonic,
                addresses: {
                    solana: solanaWallet.address,
                    qnet: qnetWallet.address
                },
                environment: this.environment
            };

        } catch (error) {
            console.error('Failed to create wallet:', error);
            throw error;
        }
    }

    /**
     * Validate password strength for production
     */
    validatePasswordStrength(password) {
        if (!password || password.length < 8) {
            throw new Error('Password must be at least 8 characters long');
        }

        if (this.isProduction) {
            // Enhanced password requirements for production
            if (password.length < 12) {
                throw new Error('Password must be at least 12 characters long in production');
            }

            const hasUppercase = /[A-Z]/.test(password);
            const hasLowercase = /[a-z]/.test(password);
            const hasNumbers = /\d/.test(password);
            const hasSpecialChars = /[!@#$%^&*(),.?":{}|<>]/.test(password);

            if (!hasUppercase || !hasLowercase || !hasNumbers || !hasSpecialChars) {
                throw new Error('Password must contain uppercase, lowercase, numbers, and special characters');
            }
        }
    }

    /**
     * Unlock wallet with enhanced security
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

            // Validate wallet data integrity
            this.validateWalletData();

            // Update environment if changed
            if (this.walletData.environment !== this.environment) {
                console.warn(`Environment changed: ${this.walletData.environment} → ${this.environment}`);
                this.walletData.environment = this.environment;
            }

            // Update last used timestamp
            this.walletData.lastUsed = Date.now();
            await this.saveWallet(password);

            // Start periodic updates
            this.startPeriodicUpdates();

            this.locked = false;
            this.notifyListeners('walletUnlocked', { 
                addresses: {
                    solana: this.walletData.networks.solana.address,
                    qnet: this.walletData.networks.qnet.address
                },
                environment: this.environment
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
     * Validate wallet data integrity
     */
    validateWalletData() {
        if (!this.walletData || typeof this.walletData !== 'object') {
            throw new Error('Invalid wallet data structure');
        }

        if (!this.walletData.networks || !this.walletData.networks.solana || !this.walletData.networks.qnet) {
            throw new Error('Missing network data');
        }

        // Validate addresses
        const solanaAddress = this.walletData.networks.solana.address;
        const qnetAddress = this.walletData.networks.qnet.address;

        if (!solanaAddress || solanaAddress.length < 32) {
            throw new Error('Invalid Solana address');
        }

        if (!qnetAddress || !this.eonGenerator.validateEONAddress(qnetAddress)) {
            throw new Error('Invalid QNet EON address');
        }
    }

    /**
     * Get activation costs with dynamic pricing
     */
    async getActivationCosts(networkSize = null) {
        try {
            if (this.walletData.phase === 1) {
                // Phase 1: 1DEV burn costs
                const pricing = await this.solanaIntegration.getCurrentBurnPricing('light');
                return {
                    light: pricing.cost,
                    full: pricing.cost,
                    super: pricing.cost,
                    currency: '1DEV',
                    phase: 1,
                    savings: pricing.savings,
                    burnProgress: pricing.burnPercent
                };
            } else {
                // Phase 2: QNC costs with network size multiplier
                // PRODUCTION: Must have real network size, no fake fallbacks
                const networkStats = await this.qnetIntegration.getNetworkStats();
                const actualNetworkSize = networkSize || networkStats?.totalNodes;
                
                if (!actualNetworkSize || actualNetworkSize <= 0) {
                    throw new Error('Network size unavailable - cannot calculate Phase 2 costs');
                }
                
                const costs = this.networkConfig.getActivationCosts(actualNetworkSize);
                
                return {
                    ...costs,
                    currency: 'QNC',
                    phase: 2
                };
            }
        } catch (error) {
            console.error('Failed to get activation costs:', error);
            // PRODUCTION: Return error state, NOT fake prices
            // Phase 1 can use base price (1500 1DEV), Phase 2 MUST have network size
            if (this.walletData.phase === 1) {
                return {
                    light: 1500,
                    full: 1500,
                    super: 1500,
                    currency: '1DEV',
                    phase: 1,
                    error: error.message
                };
            } else {
                // Phase 2: Cannot calculate without network size
                return {
                    light: null,
                    full: null,
                    super: null,
                    currency: 'QNC',
                    phase: 2,
                    error: 'Network data unavailable - cannot calculate prices',
                    unavailable: true
                };
            }
        }
    }

    /**
     * Start health monitoring for production
     */
    startHealthMonitoring() {
        if (!this.isProduction) return;

        this.healthCheckInterval = setInterval(async () => {
            try {
                // Check bridge health
                const bridgeHealth = await this.bridgeClient.checkBridgeHealth();
                
                // Check network connectivity
                const networkStatus = this.networkManager.getNetworkStatus();
                
                // Log health metrics
                if (!bridgeHealth.healthy || !networkStatus.networks.solana.connected || !networkStatus.networks.qnet.connected) {
                    console.warn('Health check failed:', { bridgeHealth, networkStatus });
                    this.notifyListeners('healthCheckFailed', { bridgeHealth, networkStatus });
                }
            } catch (error) {
                console.error('Health monitoring error:', error);
            }
        }, 60000); // Check every minute in production
    }

    /**
     * Start periodic updates
     */
    startPeriodicUpdates() {
        if (this.balanceUpdateInterval) {
            clearInterval(this.balanceUpdateInterval);
        }

        // Update balances every 30 seconds
        this.balanceUpdateInterval = setInterval(async () => {
            if (!this.locked) {
                try {
                    await this.updateAllBalances();
                } catch (error) {
                    console.error('Periodic balance update failed:', error);
                }
            }
        }, 30000);
    }

    /**
     * Enhanced error handling for production
     */
    handleError(operation, error, context = {}) {
        const errorInfo = {
            operation,
            error: error.message,
            stack: error.stack,
            context,
            timestamp: Date.now(),
            environment: this.environment,
            walletLocked: this.locked
        };

        console.error(`Wallet error in ${operation}:`, errorInfo);

        // In production, send error reports to monitoring service
        if (this.isProduction) {
            this.sendErrorReport(errorInfo);
        }

        this.notifyListeners('walletError', errorInfo);
    }

    /**
     * Send error report to monitoring service
     */
    sendErrorReport(errorInfo) {
        // This would integrate with error monitoring service
        // For now, just log for production monitoring
        console.log('Error report:', errorInfo);
    }

    /**
     * Get comprehensive wallet statistics
     */
    getWalletStats() {
        const baseStats = {
            initialized: this.initialized,
            locked: this.locked,
            networks: Object.keys(this.walletData.networks || {}),
            currentNetwork: this.walletData.currentNetwork,
            phase: this.walletData.phase,
            hasActiveNode: !!(this.walletData.networks?.qnet?.activeNode),
            created: this.walletData.created,
            lastUsed: this.walletData.lastUsed,
            environment: this.environment,
            isProduction: this.isProduction,
            version: this.walletData.version || '1.0.0'
        };

        if (this.isProduction && this.bridgeClient.getConnectionStatus) {
            baseStats.bridgeStatus = this.bridgeClient.getConnectionStatus();
        }

        return baseStats;
    }

    /**
     * Enhanced destroy method with cleanup
     */
    async destroyWallet() {
        try {
            // Clear intervals
            if (this.healthCheckInterval) {
                clearInterval(this.healthCheckInterval);
            }
            if (this.balanceUpdateInterval) {
                clearInterval(this.balanceUpdateInterval);
            }

            // Clear storage
            await this.storage.remove('wallet_data');
            
            // Clear memory
            this.walletData = {};
            this.locked = true;
            this.initialized = false;
            
            // Destroy bridge client
            if (this.bridgeClient.destroy) {
                this.bridgeClient.destroy();
            }

            this.notifyListeners('walletDestroyed', {});
            
        } catch (error) {
            console.error('Failed to destroy wallet:', error);
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
     * Migrate node to new device (same wallet)
     */
    async migrateDevice(newDeviceSignature) {
        try {
            if (this.locked) {
                throw new Error('Wallet is locked');
            }

            if (!this.walletData.networks.qnet.activeNode) {
                throw new Error('No active node to migrate');
            }

            const activeNode = this.walletData.networks.qnet.activeNode;
            const walletAddress = this.walletData.networks.qnet.address;
            const privateKey = this.getQNetPrivateKey();

            // Validate device migration (same wallet, different device)
            await this.enforcement.validateDeviceMigration(
                walletAddress,
                activeNode.code || activeNode.nodeId,
                newDeviceSignature
            );

            // Execute device migration
            const migrationResult = await this.ownershipManager.migrateDevice(
                activeNode.code || activeNode.nodeId,
                walletAddress,
                newDeviceSignature,
                privateKey
            );

            // Update device info only, wallet remains same
            this.walletData.networks.qnet.activeNode.deviceSignature = newDeviceSignature;
            this.walletData.networks.qnet.activeNode.migratedAt = Date.now();

            await this.saveWallet();
            this.notifyListeners('deviceMigrated', {
                newDevice: newDeviceSignature,
                txHash: migrationResult.txHash
            });

            return migrationResult;

        } catch (error) {
            console.error('Failed to migrate device:', error);
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
} 