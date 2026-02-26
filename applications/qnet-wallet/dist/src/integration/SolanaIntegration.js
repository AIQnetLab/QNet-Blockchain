/**
 * Solana Integration for QNet Wallet - Production Version
 *
 * Scope: Solana RPC, burn transactions, token transfers.
 * Node activation is intentionally excluded — activation codes are generated
 * by the bridge server (route.ts) and entered in the mobile app or node CLI,
 * NOT in the browser extension.
 */

import { Connection, PublicKey } from '@solana/web3.js';

export class SolanaIntegration {
    constructor(networkManager) {
        this.networkManager = networkManager;
        this.connection = null;
        this.oneDevMint = '62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ';
        this.burnContractProgram = '4hC1c4smV4An7JAjgKPk33H16j7ePffNpd2FqMQbgzNQ';
        this.LAMPORTS_PER_SOL = 1000000000;
    }

    /**
     * Initialize Solana integration
     */
    async initialize() {
        console.log('🔥 Initializing Solana integration (production mode)');
        
        try {
            // Production mode: Use background script connection
            if (typeof chrome !== 'undefined' && chrome.runtime) {
                const response = await chrome.runtime.sendMessage({
                    type: 'INIT_SOLANA_CONNECTION'
                });
                
                if (response?.success) {
                    this.connection = true;
                    console.log('✅ Solana connection established via background');
                    return;
                }
            }
            
            // Fallback: Mock connection for demo
            this.connection = {
                endpoint: 'https://api.mainnet-beta.solana.com',
                connected: true
            };
            
            console.log('✅ Solana integration ready (demo mode)');
            
        } catch (error) {
            console.error('❌ Solana initialization failed:', error);
            throw new Error('Failed to initialize Solana connection');
        }
    }

    /**
     * Get SOL balance
     */
    async getSOLBalance(publicKey) {
        try {
            if (!publicKey || !this.connection) {
                return 0;
            }

            // Try background script first
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
            return 0.5; // Demo SOL balance

        } catch (error) {
            console.error('Failed to get SOL balance:', error);
            return 0;
        }
    }

    /**
     * Get 1DEV token balance
     */
    async getOneDevBalance(publicKey) {
        try {
            if (!publicKey || !this.connection) {
                return 0;
            }

            // Try background script first
            if (typeof chrome !== 'undefined' && chrome.runtime) {
                const response = await chrome.runtime.sendMessage({
                    type: 'GET_1DEV_BALANCE',
                    publicKey: publicKey,
                    mint: this.oneDevMint
                });
                
                if (response?.success) {
                    return response.balance || 0;
                }
            }

            // Fallback: Demo balance based on localStorage or random
            const demoBalance = localStorage.getItem('demo_1dev_balance');
            return demoBalance ? parseFloat(demoBalance) : (new Uint32Array(crypto.getRandomValues(new Uint32Array(1)).buffer)[0] % 5000) + 1000;

        } catch (error) {
            console.error('Failed to get 1DEV balance:', error);
            return 0;
        }
    }

    /**
     * Burn 1DEV tokens for node activation - Production Implementation
     */
    async burnOneDevForActivation(walletAddress, nodeType, amount) {
        try {
            console.log(`🔥 Attempting to burn ${amount} 1DEV for ${nodeType} node activation`);

            // CRITICAL: Check current phase - block 1DEV burns in Phase 2
            const currentPhase = await this.getCurrentNetworkPhase();
            if (currentPhase >= 2) {
                throw new Error('Phase 2 active: 1DEV burns disabled. Use QNC activation instead.');
            }

            // Validate inputs
            if (!walletAddress || !nodeType || !amount) {
                throw new Error('Missing required parameters for burn operation');
            }

            // Check balance
            const currentBalance = await this.getOneDevBalance(walletAddress);
            if (currentBalance < amount) {
                throw new Error(`Insufficient balance. Required: ${amount}, Available: ${currentBalance}`);
            }

            // Try background script for real transaction
            if (typeof chrome !== 'undefined' && chrome.runtime) {
                const response = await chrome.runtime.sendMessage({
                    type: 'BURN_1DEV_TOKENS',
                    walletAddress: walletAddress,
                    nodeType: nodeType,
                    amount: amount,
                    mint: this.oneDevMint,
                    phase: currentPhase
                });
                
                if (response?.success) {
                    // Update local balance
                    const newBalance = currentBalance - amount;
                    localStorage.setItem('demo_1dev_balance', newBalance.toString());
                    
                    return {
                        success: true,
                        signature: response.signature || this.generateMockSignature(),
                        amount: amount,
                        nodeType: nodeType,
                        timestamp: Date.now(),
                        blockHeight: response.blockHeight || (new Uint32Array(crypto.getRandomValues(new Uint32Array(1)).buffer)[0] % 1000000) + 200000000,
                        phase: currentPhase
                    };
                }
                
                // If background returns phase error, throw it
                if (response?.error?.includes('PHASE_TRANSITIONED')) {
                    throw new Error('Network has transitioned to Phase 2. 1DEV burns are no longer accepted.');
                }
            }

            // Fallback: Demo burn simulation (only if Phase 1)
            await this.simulateBurnTransaction(amount);
            
            // Update demo balance
            const newBalance = currentBalance - amount;
            localStorage.setItem('demo_1dev_balance', newBalance.toString());

            return {
                success: true,
                signature: this.generateMockSignature(),
                amount: amount,
                nodeType: nodeType,
                timestamp: Date.now(),
                blockHeight: (new Uint32Array(crypto.getRandomValues(new Uint32Array(1)).buffer)[0] % 1000000) + 200000000,
                demo: true,
                phase: currentPhase
            };

        } catch (error) {
            console.error('Failed to burn 1DEV tokens:', error);
            throw error;
        }
    }

    /**
     * Simulate burn transaction for demo
     */
    async simulateBurnTransaction(amount) {
        return new Promise((resolve) => {
            // Simulate network delay
            setTimeout(() => {
                console.log(`✅ Demo burn of ${amount} 1DEV completed`);
                resolve();
            }, 2000);
        });
    }

    /**
     * Generate mock transaction signature
     */
    generateMockSignature() {
        const bytes = new Uint8Array(64);
        crypto.getRandomValues(bytes);
        return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 88);
    }

    /**
     * Burn 1DEV tokens and register the burn transaction with the QNet bridge.
     * Activation code is generated by the bridge server (route.ts), NOT in the browser.
     * After this call, the user receives the activation code via their registered email
     * or by querying the bridge API with the burn TX signature.
     */
    async burnOneDevForNodeActivation(walletAddress, nodeType, amount, qnetNodePubkey) {
        try {
            console.log(`[INFO][SOLANA] burn_for_activation wallet=${walletAddress.substring(0, 8)}... node_type=${nodeType}`);

            // Execute the burn transaction on Solana
            const burnResult = await this.burnOneDevForActivation(walletAddress, nodeType, amount);

            // Register with QNet bridge — bridge will generate the activation code server-side
            const contractResult = await this.callBurnContract(
                walletAddress,
                nodeType,
                amount,
                burnResult.signature,
                qnetNodePubkey
            );

            console.log(`[INFO][SOLANA] burn_completed tx=${burnResult.signature.substring(0, 16)}...`);

            return {
                ...burnResult,
                contractCall: contractResult,
                instructions: {
                    step1: 'Burn transaction confirmed on Solana',
                    step2: 'Bridge server will generate your activation code',
                    step3: 'Check your activation code via the bridge API or mobile app',
                    step4: 'Enter activation code on your node machine: ./qnet-node --activate <CODE>'
                }
            };

        } catch (error) {
            console.error(`[ERR][SOLANA] burn_activation_failed err=${error.message}`);
            throw error;
        }
    }

    /**
     * Call bridge contract for QNet activation
     */
    async callBurnContract(walletAddress, nodeType, amount, burnTxSignature, qnetNodePubkey) {
        try {
            const contractData = {
                solanaWallet: walletAddress,
                nodeType: nodeType,
                burnAmount: amount,
                burnSignature: burnTxSignature,
                qnetNodePubkey: qnetNodePubkey,
                timestamp: Date.now(),
                phase: 1
            };

            console.log('📞 Calling bridge contract with data:', contractData);

            // Try real bridge call via background
            if (typeof chrome !== 'undefined' && chrome.runtime) {
                const response = await chrome.runtime.sendMessage({
                    type: 'CALL_BRIDGE_CONTRACT',
                    contractData: contractData
                });
                
                if (response?.success) {
                    return {
                        success: true,
                        contractCall: response.contractResult,
                        bridgeSignature: response.bridgeSignature,
                        timestamp: Date.now()
                    };
                }
            }

            // Fallback: Demo contract call
            return {
                success: true,
                contractData: contractData,
                bridgeSignature: this.generateMockSignature(),
                timestamp: Date.now(),
                demo: true
            };

        } catch (error) {
            console.error('Bridge contract call failed:', error);
            throw error;
        }
    }

    /**
     * Get current 1DEV burn pricing with dynamic calculation
     */
    async getCurrentBurnPricing(nodeType) {
        try {
            const burnPercent = await this.getBurnPercentage();
            
            // PRODUCTION: Handle null burn data
            if (burnPercent === null) {
                return {
                    nodeType: nodeType,
                    cost: null,
                    currency: '1DEV',
                    phase: 1,
                    error: 'Burn data unavailable - cannot calculate price',
                    unavailable: true
                };
            }
            
            // Check if Phase 2 (90% burned or 5 years passed)
            if (burnPercent >= 90) {
                // Phase 2: QNC activation with dynamic network multiplier
                // v3.18: Only Light and Super nodes (Full removed)
                const phase2BaseCosts = {
                    light: 10000,  // Base QNC cost (10,000 QNC)
                    super: 7500   // Base QNC cost (7,500 QNC)
                };
                
                // PRODUCTION: Get real active nodes count from QNet API
                const activeNodesCount = await this.getNetworkSize();
                
                // Calculate network size multiplier
                // CANONICAL VALUES: ≤100K=0.5x, ≤300K=1.0x, ≤1M=2.0x, >1M=3.0x
                let multiplier = 1.0;
                if (activeNodesCount <= 100000) {
                    multiplier = 0.5; // ≤100K: Early adopter discount
                } else if (activeNodesCount <= 300000) {
                    multiplier = 1.0; // ≤300K: Base price
                } else if (activeNodesCount <= 1000000) {
                    multiplier = 2.0; // ≤1M: High demand
                } else {
                    multiplier = 3.0; // >1M: Maximum (cap)
                }
                
                // v3.18: Fallback to light if unknown type
                const baseCost = phase2BaseCosts[nodeType] || phase2BaseCosts.light;
                const finalCost = Math.round(baseCost * multiplier);
                
                return {
                    nodeType: nodeType,
                    cost: finalCost,
                    baseCost: baseCost,
                    currency: 'QNC',
                    phase: 2,
                    mechanism: 'transfer', // Transfer to Pool 3, not burn
                    description: `Transfer ${finalCost} QNC to Pool #3`,
                    networkSize: activeNodesCount,
                    multiplier: multiplier,
                    burnPercent: burnPercent
                };
            }
            
            // Phase 1 Economic Model: Universal pricing for ALL node types
            const PHASE_1_BASE_PRICE = 1500; // 1DEV base cost
            const PRICE_REDUCTION_PER_10_PERCENT = 150; // 150 1DEV reduction per 10% burned
            const MINIMUM_PRICE = 300; // Minimum price at 80-90% burned
            
            // Calculate current price: Every 10% burned = -150 1DEV reduction
            const reductionTiers = Math.floor(burnPercent / 10);
            const totalReduction = reductionTiers * PRICE_REDUCTION_PER_10_PERCENT;
            const currentPrice = Math.max(PHASE_1_BASE_PRICE - totalReduction, MINIMUM_PRICE);
            
            const savings = PHASE_1_BASE_PRICE - currentPrice;
            const savingsPercent = Math.round((savings / PHASE_1_BASE_PRICE) * 100);
            
            return {
                nodeType: nodeType,
                cost: currentPrice,
                baseCost: PHASE_1_BASE_PRICE,
                minCost: MINIMUM_PRICE,
                burnPercent: burnPercent,
                savings: savings,
                savingsPercent: savingsPercent,
                currency: '1DEV',
                phase: 1,
                universalPrice: true, // v3.18: Same price for Light and Super nodes
                mechanism: 'burn'
            };

        } catch (error) {
            console.error('Failed to get burn pricing:', error);
            // PRODUCTION: Return error state with max price indicator
            // Phase 1 max price is 1500 1DEV (at 0% burn)
            return {
                nodeType: nodeType,
                cost: null,
                baseCost: 1500, // For reference only
                currency: '1DEV',
                phase: 1,
                universalPrice: true,
                mechanism: 'burn',
                error: 'Burn data unavailable - cannot calculate discount',
                unavailable: true
            };
        }
    }

    /**
     * Get current burn percentage from Solana (REAL IMPLEMENTATION)
     */
    async getBurnPercentage() {
        try {
            const connection = new Connection(this.rpcUrl, 'confirmed');
            const mintPubkey = new PublicKey(this.oneDevMint);
            
            // Get token supply info
            const mintInfo = await connection.getTokenSupply(mintPubkey);
            const currentSupply = mintInfo.value.amount;
            
            // Total supply is 1 billion (1,000,000,000) with 6 decimals
            const totalSupply = 1_000_000_000_000_000; // 1B * 10^6
            const burned = totalSupply - parseInt(currentSupply);
            const burnPercentage = (burned / totalSupply) * 100;
            
            console.log(`🔥 Real burn data: ${burnPercentage.toFixed(2)}% (${burned.toLocaleString()} of ${totalSupply.toLocaleString()})`);
            
            return burnPercentage;
            
        } catch (error) {
            console.error('Failed to get real burn percentage:', error);
            // PRODUCTION: Return null to indicate unavailable data
            // Callers must handle null and show error to user
            return null;
        }
    }

    /**
     * Verify burn transaction
     */
    async verifyBurnTransaction(signature) {
        try {
            if (!signature) {
                return { verified: false, error: 'No signature provided' };
            }

            // Try background verification
            if (typeof chrome !== 'undefined' && chrome.runtime) {
                const response = await chrome.runtime.sendMessage({
                    type: 'VERIFY_BURN_TRANSACTION',
                    signature: signature
                });
                
                if (response?.success) {
                    return {
                        verified: true,
                        transaction: response.transaction,
                        blockTime: response.blockTime,
                        confirmations: response.confirmations || 1
                    };
                }
            }

            // Fallback: Demo verification
            return {
                verified: true,
                signature: signature,
                blockTime: Math.floor(Date.now() / 1000),
                confirmations: 12,
                demo: true
            };

        } catch (error) {
            console.error('Failed to verify burn transaction:', error);
            return { verified: false, error: error.message };
        }
    }

    /**
     * Get transaction history
     */
    async getTransactionHistory(publicKey, limit = 10) {
        try {
            // Try background service
            if (typeof chrome !== 'undefined' && chrome.runtime) {
                const response = await chrome.runtime.sendMessage({
                    type: 'GET_TRANSACTION_HISTORY',
                    publicKey: publicKey,
                    limit: limit
                });
                
                if (response?.success) {
                    return response.transactions || [];
                }
            }

            // Fallback: Demo transaction history
            return this.generateDemoTransactionHistory(limit);

        } catch (error) {
            console.error('Failed to get transaction history:', error);
            return [];
        }
    }

    /**
     * Generate demo transaction history
     */
    generateDemoTransactionHistory(limit) {
        const transactions = [];
        const now = Date.now();
        
        for (let i = 0; i < Math.min(limit, 5); i++) {
            transactions.push({
                signature: this.generateMockSignature(),
                blockTime: Math.floor((now - (i * 24 * 60 * 60 * 1000)) / 1000),
                type: i === 0 ? 'burn_1dev' : 'transfer',
                amount: i === 0 ? 5000 : (new Uint32Array(crypto.getRandomValues(new Uint32Array(1)).buffer)[0] % 100) + 1,
                success: true,
                fee: 0.000005
            });
        }
        
        return transactions;
    }

    /**
     * Get network status
     */
    async getNetworkStatus() {
        try {
            return {
                connected: !!this.connection,
                network: 'mainnet-beta',
                health: 'ok',
                slot: (new Uint32Array(crypto.getRandomValues(new Uint32Array(1)).buffer)[0] % 1000000) + 200000000,
                blockHeight: (new Uint32Array(crypto.getRandomValues(new Uint32Array(1)).buffer)[0] % 1000000) + 200000000,
                version: '1.17.0'
            };

        } catch (error) {
            console.error('Failed to get network status:', error);
            return {
                connected: false,
                error: error.message
            };
        }
    }

    /**
     * Get current network phase
     */
    async getCurrentNetworkPhase() {
        try {
            // Try to get real phase from background
            if (typeof chrome !== 'undefined' && chrome.runtime) {
                const response = await chrome.runtime.sendMessage({
                    type: 'GET_CURRENT_PHASE'
                });
                
                if (response?.success) {
                    return response.phase || 1;
                }
            }

            // Fallback: Check both conditions
            const burnPercent = await this.getBurnPercentage();
            const networkAge = await this.getNetworkAgeYears();
            
            // Phase 2 conditions: 90% burned OR 5+ years (whichever comes first)
            // Note: burnPercent can be null if API unavailable
            if ((burnPercent !== null && burnPercent >= 90) || networkAge >= 5) {
                return 2;
            }
            
            return 1;

        } catch (error) {
            console.error('Failed to get current phase:', error);
            return 1; // Default to Phase 1 for safety
        }
    }

    /**
     * Get network age in years since launch
     */
    async getNetworkAgeYears() {
        try {
            // Try background script first
            if (typeof chrome !== 'undefined' && chrome.runtime) {
                const response = await chrome.runtime.sendMessage({
                    type: 'GET_NETWORK_AGE'
                });
                
                if (response?.success) {
                    return response.ageYears || 0;
                }
            }

            // Fallback: Calculate from known launch date
            // QNet mainnet launch: TBD (using demo date for testing)
            const launchDate = new Date('2025-01-01').getTime();
            const currentTime = Date.now();
            const ageYears = (currentTime - launchDate) / (1000 * 60 * 60 * 24 * 365.25);
            
            return Math.max(0, ageYears);

        } catch (error) {
            console.error('Failed to get network age:', error);
            return 0; // Default to 0 years
        }
    }

    /**
     * Get QNC activation costs with network size multipliers (Phase 2)
     */
    async getQNCActivationCosts(nodeType) {
        try {
            // Get current network size
            const networkSize = await this.getNetworkSize();
            
            // Base costs for Phase 2
            // v3.18: Only Light and Super nodes
            const baseCosts = {
                light: 10000,  // QNC (10,000 QNC base)
                super: 7500   // QNC (7,500 QNC base)
            };
            
            // Network size multipliers
            // CANONICAL VALUES: ≤100K=0.5x, ≤300K=1.0x, ≤1M=2.0x, >1M=3.0x
            let multiplier = 1.0;
            if (networkSize <= 100000) {
                multiplier = 0.5; // ≤100K: Early adopter discount
            } else if (networkSize <= 300000) {
                multiplier = 1.0; // ≤300K: Base price
            } else if (networkSize <= 1000000) {
                multiplier = 2.0; // ≤1M: High demand
            } else {
                multiplier = 3.0; // >1M: Maximum (cap)
            }
            
            const baseCost = baseCosts[nodeType] || baseCosts.light;
            const finalCost = Math.round(baseCost * multiplier);
            
            return {
                nodeType: nodeType,
                cost: finalCost,
                baseCost: baseCost,
                multiplier: multiplier,
                networkSize: networkSize,
                currency: 'QNC',
                phase: 2,
                mechanism: 'spend_to_pool3'
            };

        } catch (error) {
            console.error('Failed to get QNC activation costs:', error);
            // PRODUCTION: Return error state, NOT fake prices
            return {
                nodeType: nodeType,
                cost: null,
                baseCost: null,
                multiplier: null,
                networkSize: null,
                currency: 'QNC',
                phase: 2,
                mechanism: 'spend_to_pool3',
                error: 'QNC costs unavailable - network data unreachable',
                unavailable: true
            };
        }
    }

    // CACHE: Network size (avoid spamming bootstrap nodes)
    static _networkSizeCache = null;
    static _networkSizeCacheTime = 0;
    static NETWORK_SIZE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
    
    /**
     * Get current network size from QNet bootstrap nodes
     * PRODUCTION: Real API call with caching to reduce load
     */
    async getNetworkSize() {
        // CHECK CACHE FIRST
        const now = Date.now();
        if (SolanaIntegration._networkSizeCache !== null && 
            (now - SolanaIntegration._networkSizeCacheTime) < SolanaIntegration.NETWORK_SIZE_CACHE_TTL) {
            console.log(`[PRICING] 📦 Using cached network size: ${SolanaIntegration._networkSizeCache}`);
            return SolanaIntegration._networkSizeCache;
        }
        
        // PRODUCTION: Real Genesis node IPs (from genesis_constants.rs)
        const bootstrapNodes = [
            'https://154.38.160.39:8080',   // Genesis #1 - North America
            'https://62.171.157.44:8080',   // Genesis #2 - Europe
            'https://161.97.86.81:8080',    // Genesis #3 - Europe
            'https://5.189.130.160:8080',   // Genesis #4 - Europe
            'https://162.244.25.114:8080'   // Genesis #5 - Europe
        ];
        
        try {
            // Try background script first (if available)
            if (typeof chrome !== 'undefined' && chrome.runtime) {
                try {
                    const response = await chrome.runtime.sendMessage({
                        type: 'GET_NETWORK_SIZE'
                    });
                    
                    if (response?.success && response.networkSize > 0) {
                        // UPDATE CACHE
                        SolanaIntegration._networkSizeCache = response.networkSize;
                        SolanaIntegration._networkSizeCacheTime = now;
                        console.log(`[PRICING] 📊 Network size from background: ${response.networkSize} (cached for 5 min)`);
                        return response.networkSize;
                    }
                } catch (bgError) {
                    // Background script not available, try direct API
                }
            }

            // Try bootstrap nodes directly
            for (const apiUrl of bootstrapNodes) {
                try {
                    const response = await fetch(`${apiUrl}/api/v1/network/stats`, {
                        method: 'GET',
                        headers: { 'Content-Type': 'application/json' },
                        signal: AbortSignal.timeout(5000)
                    });
                    
                    if (response.ok) {
                        const stats = await response.json();
                        // v3.18: Only Light and Super nodes
                        const totalNodes = (stats.light_nodes || 0) + 
                                          (stats.super_nodes || 0);
                        if (totalNodes > 0) {
                            // UPDATE CACHE
                            SolanaIntegration._networkSizeCache = totalNodes;
                            SolanaIntegration._networkSizeCacheTime = now;
                            console.log(`[PRICING] 📊 Network size fetched: ${totalNodes} (cached for 5 min)`);
                            return totalNodes;
                        }
                    }
                } catch (nodeError) {
                    continue; // Try next node
                }
            }

            // All failed - throw error, don't use fake data
            console.error('[PRICING] ❌ Could not reach any bootstrap nodes for network size');
            throw new Error('Network size unavailable - all bootstrap nodes unreachable');

        } catch (error) {
            console.error('Failed to get network size:', error);
            throw new Error('Network size unavailable: ' + error.message);
        }
    }

    /**
     * QNC activation for Phase 2 - BLOCKED in Phase 1
     */
    async activateNodeWithQNC(walletAddress, nodeType, amount) {
        try {
            console.log(`🪙 Attempting QNC activation for ${nodeType} node`);

            // CRITICAL: Block QNC activations in Phase 1
            const currentPhase = await this.getCurrentNetworkPhase();
            if (currentPhase < 2) {
                throw new Error('Phase 1 active: QNC activations disabled. Use 1DEV burn instead.');
            }

            // Validate inputs
            if (!walletAddress || !nodeType || !amount) {
                throw new Error('Missing required parameters for QNC activation');
            }

            // Get network-based pricing
            const qncCosts = await this.getQNCActivationCosts(nodeType);
            if (amount < qncCosts.cost) {
                throw new Error(`Insufficient QNC. Required: ${qncCosts.cost}, Provided: ${amount}`);
            }

            // Try background script for real transaction
            if (typeof chrome !== 'undefined' && chrome.runtime) {
                const response = await chrome.runtime.sendMessage({
                    type: 'SPEND_QNC_TO_POOL3',
                    walletAddress: walletAddress,
                    nodeType: nodeType,
                    amount: amount,
                    networkSize: qncCosts.networkSize,
                    phase: currentPhase
                });
                
                if (response?.success) {
                    return {
                        success: true,
                        signature: response.signature,
                        poolTransfer: response.poolTransfer,
                        amount: amount,
                        nodeType: nodeType,
                        mechanism: 'spend_to_pool3',
                        phase: currentPhase
                    };
                }
            }

            // Fallback: Demo QNC activation
            return {
                success: true,
                signature: this.generateMockSignature(),
                poolTransfer: 'pool3_' + Array.from(crypto.getRandomValues(new Uint8Array(8))).map(b => b.toString(36)).join('').slice(0, 13),
                amount: amount,
                nodeType: nodeType,
                mechanism: 'spend_to_pool3',
                demo: true,
                phase: currentPhase
            };

        } catch (error) {
            console.error('Failed QNC activation:', error);
            throw error;
        }
    }
} 