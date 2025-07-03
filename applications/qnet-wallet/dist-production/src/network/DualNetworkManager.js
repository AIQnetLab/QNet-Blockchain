/**
 * QNet Dual Network Manager
 * Manages switching between Solana and QNet networks
 * Handles EON address generation and cross-chain operations
 */

// Production version - no npm dependencies
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
            // Initialize Solana connection (production compatible)
            this.networks.solana.connection = {
                rpcUrl: this.networks.solana.rpcUrl,
                type: 'solana',
                // Wrapper for background script calls
                async getBalance(address) {
                    if (typeof chrome !== 'undefined' && chrome.runtime) {
                        const response = await chrome.runtime.sendMessage({
                            type: 'GET_SOL_BALANCE',
                            address: address
                        });
                        return response?.balance || 0;
                    }
                    return 2.5; // Demo fallback
                }
            };

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
     * Get Solana balances (SOL, 1DEV)
     */
    async getSolanaBalances() {
        try {
            if (!this.networks.solana.wallet) {
                return { SOL: 0, '1DEV': 0 };
            }

            const publicKey = this.networks.solana.wallet.publicKey;
            
            // Get SOL balance (production compatible)
            const solBalance = await this.getSolanaBalance(publicKey);
            
            // Get 1DEV balance (if token account exists)
            const oneDevBalance = await this.getTokenBalance(
                publicKey,
                '9GcdXAo2EyjNdNLuQoScSVbfJSnh9RdkSS8YYKnGQ8Pf' // 1DEV mint
            );

            return {
                SOL: solBalance, // Already converted in getSolanaBalance
                '1DEV': oneDevBalance
            };
        } catch (error) {
            console.error('Failed to get Solana balances:', error);
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
     * Get SOL balance for address (production compatible)
     */
    async getSolanaBalance(publicKey) {
        try {
            // Production implementation: Use background script
            if (typeof chrome !== 'undefined' && chrome.runtime) {
                const response = await chrome.runtime.sendMessage({
                    type: 'GET_SOL_BALANCE',
                    publicKey: publicKey
                });
                
                if (response?.success) {
                    return response.balance || 0;
                }
            }

            // Fallback: Demo balance
            return 2.5; // Demo SOL balance
        } catch (error) {
            console.error('Failed to get SOL balance:', error);
            return 0;
        }
    }

    /**
     * Get token balance for Solana address (production compatible)
     */
    async getTokenBalance(publicKey, mintAddress) {
        try {
            // Production implementation: Use background script
            if (typeof chrome !== 'undefined' && chrome.runtime) {
                const response = await chrome.runtime.sendMessage({
                    type: 'GET_TOKEN_BALANCE',
                    publicKey: publicKey,
                    mintAddress: mintAddress
                });
                
                if (response?.success) {
                    return response.balance || 0;
                }
            }

            // Fallback: Demo balance
            return mintAddress === '9GcdXAo2EyjNdNLuQoScSVbfJSnh9RdkSS8YYKnGQ8Pf' ? 1350 : 0;
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
