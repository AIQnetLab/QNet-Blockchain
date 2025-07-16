/**
 * QNet Dual Network Manager
 * Manages switching between Solana and QNet networks
 * Handles EON address generation and cross-chain operations
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { secureBIP39 } from '../crypto/ProductionBIP39.js';

export class DualNetworkManager {
    constructor() {
        this.currentNetwork = 'solana'; // Start with Solana for Phase 1
        this.networks = {
            solana: {
                rpcUrl: 'https://api.mainnet-beta.solana.com',
                connection: null,
                wallet: null
            },
            qnet: {
                rpcUrl: 'https://api.qnet.network',
                connection: null,
                wallet: null
            }
        };
        this.currentPhase = 1; // Will be detected dynamically
    }

    /**
     * Initialize network connections
     */
    async initialize() {
        try {
            // Initialize Solana connection
            this.networks.solana.connection = new Connection(
                this.networks.solana.rpcUrl,
                'confirmed'
            );

            // Initialize QNet connection (custom RPC client)
            this.networks.qnet.connection = await this.createQNetConnection();

            // Detect current phase
            this.currentPhase = await this.detectCurrentPhase();

            return true;
        } catch (error) {
            console.error('Failed to initialize networks:', error);
            throw error;
        }
    }

    /**
     * Switch to Solana network
     */
    async switchToSolana() {
        try {
            this.currentNetwork = 'solana';
            
            // Update UI to show Solana interface
            await this.updateNetworkUI('solana');
            
            // Load Solana balances
            const balances = await this.getSolanaBalances();
            
            return {
                network: 'solana',
                address: this.networks.solana.wallet?.publicKey?.toString(),
                balances: balances,
                phase: this.currentPhase,
                ui: 'activation' // Show activation UI for Phase 1
            };
        } catch (error) {
            throw new Error(`Failed to switch to Solana: ${error.message}`);
        }
    }

    /**
     * Switch to QNet network
     */
    async switchToQNet() {
        try {
            this.currentNetwork = 'qnet';
            
            // Generate or load EON address
            const eonAddress = await this.getOrCreateEonAddress();
            
            // Update UI to show QNet interface
            await this.updateNetworkUI('qnet');
            
            // Load QNet balances and node info
            const balances = await this.getQNetBalances(eonAddress);
            const nodeInfo = await this.getNodeInfo(eonAddress);
            
            return {
                network: 'qnet',
                address: eonAddress,
                balances: balances,
                nodeInfo: nodeInfo,
                phase: this.currentPhase,
                ui: this.currentPhase === 2 ? 'native_activation' : 'node_management'
            };
        } catch (error) {
            throw new Error(`Failed to switch to QNet: ${error.message}`);
        }
    }

    /**
     * Generate EON address format: 7a9bk4f2eon8x3m5z1c7
     */
    async generateEonAddress(seedPhrase) {
        try {
            // Derive seed from mnemonic
            const seed = await secureBIP39.importFromExternalWallet(seedPhrase, '');
            
            // Generate address components
            const part1 = this.generateAddressPart(seed.seed.slice(0, 8));
            const part2 = this.generateAddressPart(seed.seed.slice(8, 16));
            const checksum = this.calculateAddressChecksum(part1 + part2);
            
            return `${part1}eon${part2}${checksum}`;
        } catch (error) {
            throw new Error(`Failed to generate EON address: ${error.message}`);
        }
    }

    /**
     * Generate address part from seed bytes
     */
    generateAddressPart(seedBytes) {
        const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
        let result = '';
        
        for (let i = 0; i < 8; i++) {
            const byte = seedBytes[i] || 0;
            result += chars[byte % chars.length];
        }
        
        return result;
    }

    /**
     * Calculate checksum for EON address
     */
    calculateAddressChecksum(addressPart) {
        // Simple checksum algorithm
        let hash = 0;
        for (let i = 0; i < addressPart.length; i++) {
            hash = ((hash << 5) - hash + addressPart.charCodeAt(i)) & 0xffffffff;
        }
        
        const chars = '0123456789abcdef';
        return Math.abs(hash % 65536).toString(16).padStart(4, '0');
    }

    /**
     * Get or create EON address for current wallet
     */
    async getOrCreateEonAddress() {
        try {
            // Check if EON address already exists in storage
            const stored = await this.loadFromStorage('qnet_eon_address');
            if (stored) {
                return stored;
            }

            // Generate new EON address from wallet seed
            const walletData = await this.loadFromStorage('qnet_wallet_data');
            if (!walletData?.mnemonic) {
                throw new Error('No wallet found for EON address generation');
            }

            const eonAddress = await this.generateEonAddress(walletData.mnemonic);
            
            // Store EON address
            await this.saveToStorage('qnet_eon_address', eonAddress);
            
            return eonAddress;
        } catch (error) {
            throw new Error(`Failed to get EON address: ${error.message}`);
        }
    }

    /**
     * Detect current QNet phase
     */
    async detectCurrentPhase() {
        try {
            // Check burn percentage from Solana contract
            const burnedPercent = await this.getBurnedPercentageFromSolana();
            
            // Check network age from QNet
            const networkAge = await this.getNetworkAgeFromQNet();
            
            // Phase 2 conditions: 90% burned OR 5+ years
            if (burnedPercent >= 90 || networkAge >= 5) {
                return 2;
            }
            
            return 1;
        } catch (error) {
            console.warn('Failed to detect phase, defaulting to Phase 1:', error);
            return 1;
        }
    }

    /**
     * Get QNet testnet balance
     */
    async getQNetBalance(address) {
        try {
            if (!address) {
                return 0;
            }

            // Real QNet testnet API integration
            const response = await fetch('http://localhost:8080/api/v1/account/balance', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    address: address
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();

            if (data.success) {
                // Convert from smallest units to QNC
                const balance = data.balance / 1000000000; // 1 QNC = 1B smallest units
                console.log(`💰 Real QNet testnet balance for ${address}: ${balance} QNC`);
                return balance;
            } else {
                throw new Error(data.error || 'Failed to get QNet balance');
            }

        } catch (error) {
            console.error('Failed to get QNet testnet balance:', error);
            
            // Fallback for testnet development - provide faucet balance
            if (address.startsWith('test') || address.startsWith('faucet')) {
                console.log('🔄 Using testnet faucet balance');
                return 1000000; // 1M QNC for testing
            }
            
            return 0;
        }
    }

    /**
     * Get Solana balances (SOL, 1DEV) - Updated for real devnet
     */
    async getSolanaBalances() {
        try {
            if (!this.networks.solana.wallet) {
                return { SOL: 0, '1DEV': 0 };
            }

            const publicKey = this.networks.solana.wallet.publicKey;
            
            // Get SOL balance from real devnet
            const solBalance = await this.networks.solana.connection.getBalance(publicKey);
            
            // Get 1DEV balance (if token account exists) from real devnet
            const oneDevBalance = await this.getTokenBalance(
                publicKey,
                '62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ' // 1DEV mint
            );

            const result = {
                SOL: solBalance / 1e9, // Convert lamports to SOL
                '1DEV': oneDevBalance
            };

            console.log('💰 Real Solana devnet balances:', result);
            return result;
        } catch (error) {
            console.error('Failed to get Solana devnet balances:', error);
            return { SOL: 0, '1DEV': 0 };
        }
    }

    /**
     * Get QNet balances (QNC)
     */
    async getQNetBalances(eonAddress) {
        try {
            // Call QNet RPC to get QNC balance
            const response = await this.qnetRpcCall('get_balance', {
                address: eonAddress
            });

            return {
                QNC: response.balance || 0
            };
        } catch (error) {
            console.error('Failed to get QNet balances:', error);
            return { QNC: 0 };
        }
    }

    /**
     * Get node information for address
     */
    async getNodeInfo(eonAddress) {
        try {
            const response = await this.qnetRpcCall('get_node_info', {
                owner_address: eonAddress
            });

            if (!response.node) {
                return null; // No active node
            }

            return {
                code: response.node.activation_code,
                type: response.node.type,
                status: response.node.status,
                uptime: response.node.uptime_percentage,
                rewards: response.node.daily_rewards,
                activated_at: response.node.activated_at
            };
        } catch (error) {
            console.error('Failed to get node info:', error);
            return null;
        }
    }

    /**
     * Update UI based on current network
     */
    async updateNetworkUI(network) {
        try {
            // Emit event for UI components to listen
            const event = new CustomEvent('networkChanged', {
                detail: {
                    network: network,
                    phase: this.currentPhase,
                    timestamp: Date.now()
                }
            });
            
            window.dispatchEvent(event);
            
            // Update visual indicators
            document.querySelectorAll('.network-btn').forEach(btn => {
                btn.classList.remove('active');
                if (btn.dataset.network === network) {
                    btn.classList.add('active');
                }
            });

        } catch (error) {
            console.error('Failed to update network UI:', error);
        }
    }

    /**
     * Create QNet RPC connection
     */
    async createQNetConnection() {
        // Placeholder for QNet RPC client
        return {
            url: this.networks.qnet.rpcUrl,
            connected: true
        };
    }

    /**
     * Make RPC call to QNet network
     */
    async qnetRpcCall(method, params) {
        try {
            const response = await fetch(this.networks.qnet.rpcUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    method: method,
                    params: params,
                    id: Date.now()
                })
            });

            const data = await response.json();
            
            if (data.error) {
                throw new Error(data.error.message);
            }

            return data.result;
        } catch (error) {
            throw new Error(`QNet RPC call failed: ${error.message}`);
        }
    }

    /**
     * Get token balance for Solana address
     */
    async getTokenBalance(publicKey, mintAddress) {
        try {
            const mint = new PublicKey(mintAddress);
            const tokenAccounts = await this.networks.solana.connection.getTokenAccountsByOwner(
                publicKey,
                { mint: mint }
            );

            if (tokenAccounts.value.length === 0) {
                return 0;
            }

            const balance = await this.networks.solana.connection.getTokenAccountBalance(
                tokenAccounts.value[0].pubkey
            );

            return parseFloat(balance.value.uiAmount) || 0;
        } catch (error) {
            return 0;
        }
    }

    /**
     * Helper methods for storage
     */
    async saveToStorage(key, data) {
        return new Promise((resolve, reject) => {
            chrome.storage.local.set({ [key]: data }, () => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                } else {
                    resolve();
                }
            });
        });
    }

    async loadFromStorage(key) {
        return new Promise((resolve, reject) => {
            chrome.storage.local.get([key], (result) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                } else {
                    resolve(result[key]);
                }
            });
        });
    }

    /**
     * Get burned percentage from Solana contract
     */
    async getBurnedPercentageFromSolana() {
        try {
            // Call Solana contract to get burn statistics
            // Placeholder implementation
            return 15; // 15% burned
        } catch (error) {
            return 0;
        }
    }

    /**
     * Get network age from QNet
     */
    async getNetworkAgeFromQNet() {
        try {
            const response = await this.qnetRpcCall('get_network_info');
            return response.age_years || 0;
        } catch (error) {
            return 0;
        }
    }

    /**
     * Get current network
     */
    getCurrentNetwork() {
        return this.currentNetwork;
    }

    /**
     * Get current phase
     */
    getCurrentPhase() {
        return this.currentPhase;
    }
}

// Export singleton instance
export const dualNetworkManager = new DualNetworkManager();
export default DualNetworkManager; 