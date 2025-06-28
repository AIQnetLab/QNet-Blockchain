/**
 * Dual Network Manager for QNet Wallet
 * Manages both Solana (Phase 1 activation) and QNet (node management) networks
 */

import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js';

export class DualNetworkManager {
    constructor() {
        this.networks = {
            solana: {
                name: 'Solana',
                rpc: 'https://api.devnet.solana.com',
                connection: null,
                connected: false,
                purpose: 'Phase 1 activation (1DEV burn)'
            },
            qnet: {
                name: 'QNet',
                rpc: 'http://localhost:8080',
                connection: null,
                connected: false,
                purpose: 'Node management + Phase 2 activation'
            }
        };
        
        this.currentNetwork = 'solana'; // Default to Solana for Phase 1
        this.phase = 1; // Current network phase
        this.listeners = new Set();
    }

    /**
     * Initialize dual network connections
     */
    async initialize() {
        try {
            // Initialize Solana connection
            await this.initializeSolana();
            
            // Initialize QNet connection
            await this.initializeQNet();
            
            // Detect current phase
            await this.detectCurrentPhase();
            
            console.log('Dual network manager initialized successfully');
            this.notifyListeners('initialized', { networks: this.networks, phase: this.phase });
            
        } catch (error) {
            console.error('Failed to initialize dual network manager:', error);
            throw error;
        }
    }

    /**
     * Initialize Solana network connection
     */
    async initializeSolana() {
        try {
            this.networks.solana.connection = new Connection(
                this.networks.solana.rpc,
                'confirmed'
            );
            
            // Test connection
            const version = await this.networks.solana.connection.getVersion();
            this.networks.solana.connected = true;
            this.networks.solana.version = version;
            
            console.log('Solana network connected:', version);
            
        } catch (error) {
            console.warn('Solana network connection failed:', error);
            this.networks.solana.connected = false;
        }
    }

    /**
     * Initialize QNet network connection
     */
    async initializeQNet() {
        try {
            // Test QNet RPC connection
            const response = await fetch(`${this.networks.qnet.rpc}/api/v1/status`, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' }
            });
            
            if (response.ok) {
                const status = await response.json();
                this.networks.qnet.connected = true;
                this.networks.qnet.status = status;
                console.log('QNet network connected:', status);
            } else {
                throw new Error(`QNet RPC returned ${response.status}`);
            }
            
        } catch (error) {
            console.warn('QNet network connection failed:', error);
            this.networks.qnet.connected = false;
        }
    }

    /**
     * Detect current network phase
     */
    async detectCurrentPhase() {
        try {
            // Check burn percentage from Solana
            const burnedPercent = await this.getBurnedPercentFromSolana();
            
            // Check network age from QNet
            const timeElapsed = await this.getNetworkAgeFromQNet();
            
            // Phase 2 triggers when 90% burned OR 5 years elapsed
            this.phase = (burnedPercent >= 90 || timeElapsed >= 5) ? 2 : 1;
            
            console.log(`Current phase: ${this.phase} (${burnedPercent}% burned, ${timeElapsed} years)`);
            
        } catch (error) {
            console.warn('Phase detection failed, defaulting to Phase 1:', error);
            this.phase = 1;
        }
    }

    /**
     * Switch to Solana network
     */
    async switchToSolana() {
        if (!this.networks.solana.connected) {
            await this.initializeSolana();
        }
        
        this.currentNetwork = 'solana';
        this.notifyListeners('networkChanged', { 
            network: 'solana', 
            purpose: this.networks.solana.purpose 
        });
        
        console.log('Switched to Solana network');
        return this.networks.solana;
    }

    /**
     * Switch to QNet network
     */
    async switchToQNet() {
        if (!this.networks.qnet.connected) {
            await this.initializeQNet();
        }
        
        this.currentNetwork = 'qnet';
        this.notifyListeners('networkChanged', { 
            network: 'qnet', 
            purpose: this.networks.qnet.purpose 
        });
        
        console.log('Switched to QNet network');
        return this.networks.qnet;
    }

    /**
     * Get current network info
     */
    getCurrentNetwork() {
        return {
            name: this.currentNetwork,
            ...this.networks[this.currentNetwork]
        };
    }

    /**
     * Get all network status
     */
    getNetworkStatus() {
        return {
            current: this.currentNetwork,
            phase: this.phase,
            networks: this.networks
        };
    }

    /**
     * Get burned percentage from Solana blockchain
     */
    async getBurnedPercentFromSolana() {
        if (!this.networks.solana.connected) {
            return 0;
        }

        try {
            // Query burn tracker contract for burn statistics
            // This would connect to the actual Solana burn contract
            // For now, return mock data based on current development
            return 25; // 25% burned (example)
            
        } catch (error) {
            console.warn('Failed to get burn percentage:', error);
            return 0;
        }
    }

    /**
     * Get network age from QNet blockchain
     */
    async getNetworkAgeFromQNet() {
        if (!this.networks.qnet.connected) {
            return 0;
        }

        try {
            const response = await fetch(`${this.networks.qnet.rpc}/api/v1/network/age`);
            if (response.ok) {
                const data = await response.json();
                return data.years || 0;
            }
            return 0;
            
        } catch (error) {
            console.warn('Failed to get network age:', error);
            return 0;
        }
    }

    /**
     * Get Solana connection
     */
    getSolanaConnection() {
        return this.networks.solana.connection;
    }

    /**
     * Get QNet RPC URL
     */
    getQNetRPC() {
        return this.networks.qnet.rpc;
    }

    /**
     * Execute network-specific operation
     */
    async executeNetworkOperation(operation, params) {
        const network = this.getCurrentNetwork();
        
        switch (this.currentNetwork) {
            case 'solana':
                return await this.executeSolanaOperation(operation, params);
            case 'qnet':
                return await this.executeQNetOperation(operation, params);
            default:
                throw new Error(`Unsupported network: ${this.currentNetwork}`);
        }
    }

    /**
     * Execute Solana-specific operation
     */
    async executeSolanaOperation(operation, params) {
        if (!this.networks.solana.connected) {
            throw new Error('Solana network not connected');
        }

        switch (operation) {
            case 'getBalance':
                return await this.networks.solana.connection.getBalance(new PublicKey(params.address));
            case 'getTokenBalance':
                return await this.getTokenBalance(params.address, params.mint);
            case 'sendTransaction':
                return await this.networks.solana.connection.sendTransaction(params.transaction);
            default:
                throw new Error(`Unsupported Solana operation: ${operation}`);
        }
    }

    /**
     * Execute QNet-specific operation
     */
    async executeQNetOperation(operation, params) {
        if (!this.networks.qnet.connected) {
            throw new Error('QNet network not connected');
        }

        const response = await fetch(`${this.networks.qnet.rpc}/api/v1/${operation}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });

        if (!response.ok) {
            throw new Error(`QNet operation failed: ${response.status}`);
        }

        return await response.json();
    }

    /**
     * Get token balance on Solana
     */
    async getTokenBalance(address, mintAddress) {
        try {
            const tokenAccounts = await this.networks.solana.connection.getTokenAccountsByOwner(
                new PublicKey(address),
                { mint: new PublicKey(mintAddress) }
            );

            if (tokenAccounts.value.length === 0) {
                return 0;
            }

            const accountInfo = await this.networks.solana.connection.getTokenAccountBalance(
                tokenAccounts.value[0].pubkey
            );

            return accountInfo.value.uiAmount || 0;
            
        } catch (error) {
            console.warn('Failed to get token balance:', error);
            return 0;
        }
    }

    /**
     * Add network event listener
     */
    addListener(callback) {
        this.listeners.add(callback);
    }

    /**
     * Remove network event listener
     */
    removeListener(callback) {
        this.listeners.delete(callback);
    }

    /**
     * Notify all listeners of network events
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
     * Update network configuration
     */
    updateNetworkConfig(network, config) {
        if (this.networks[network]) {
            Object.assign(this.networks[network], config);
            this.notifyListeners('configUpdated', { network, config });
        }
    }

    /**
     * Check if network supports operation
     */
    supportsOperation(operation) {
        const network = this.currentNetwork;
        
        const supportMatrix = {
            solana: ['burnTokens', 'getTokenBalance', 'sendSOL', 'requestActivationCode'],
            qnet: ['activateNode', 'getNodeStatus', 'sendQNC', 'manageNode', 'sendToPool3']
        };

        return supportMatrix[network]?.includes(operation) || false;
    }

    /**
     * Get network-specific constants
     */
    getNetworkConstants() {
        const constants = {
            solana: {
                oneDevMint: '9GcdXAo2EyjNdNLuQoScSVbfJSnh9RdkSS8YYKnGQ8Pf',
                derivationPath: "m/44'/501'/0'/0'",
                burnAddress: 'BURN1111111111111111111111111111111111111111',
                rpcUrl: this.networks.solana.rpc
            },
            qnet: {
                qncDecimals: 9,
                activationCosts: {
                    light: 5000,
                    full: 7500,
                    super: 10000
                },
                rpcUrl: this.networks.qnet.rpc
            }
        };

        return constants[this.currentNetwork] || {};
    }
} 