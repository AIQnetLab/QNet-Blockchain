/**
 * QNet Activation Bridge Client - Production Ready
 * Integrates with 1dev-burn-contract and production QNet bridge
 * Handles Phase 1 (1DEV burn) and Phase 2 (QNC Pool 3) activations
 */

export class ActivationBridgeClient {
    constructor(networkManager) {
        this.networkManager = networkManager;
        
        // Production bridge endpoints
        this.bridgeEndpoints = {
            mainnet: 'https://bridge.qnet.io',
            testnet: 'https://testnet-bridge.qnet.io',
            local: 'http://localhost:8080'
        };
        
        this.currentEndpoint = this.bridgeEndpoints.testnet;
        this.timeout = 30000;
        this.authToken = null;
        
        // Phase 2 QNC activation costs with network size multipliers
        this.qncActivationCosts = {
            baseMultipliers: {
                '0-100k': 0.5,
                '100k-1m': 1.0,
                '1m-10m': 2.0,
                '10m+': 3.0
            },
            baseCosts: {
                Light: 5000,
                Full: 7500,
                Super: 10000
            }
        };
        
        // 1dev-burn-contract integration for Phase 1
        this.burnContractAddress = '1DEVBurnContract...'; // Production 1DEV burn contract address
    }

    /**
     * Request activation token from bridge
     */
    async requestActivationToken(burnTx, nodeType, qnetPublicKey, solanaAddress) {
        try {
            const requestData = {
                qnet_pubkey: qnetPublicKey,
                solana_txid: burnTx.signature,
                solana_pubkey_user: solanaAddress,
                node_type: nodeType,
                burn_amount: burnTx.amount,
                timestamp: burnTx.timestamp
            };

            console.log('Requesting activation token:', requestData);

            const response = await this.makeRequest('/api/v1/request_activation_token', {
                method: 'POST',
                body: JSON.stringify(requestData)
            });

            if (response.success) {
                return {
                    success: true,
                    activationCode: response.activation_code,
                    nodeId: response.node_id,
                    expiresAt: response.expires_at,
                    bridgeSignature: response.bridge_signature
                };
            } else {
                throw new Error(response.error || 'Bridge request failed');
            }

        } catch (error) {
            console.error('Failed to request activation token:', error);
            throw error;
        }
    }

    /**
     * Verify burn transaction with bridge
     */
    async verifyBurnTransaction(txSignature, expectedAmount, burnerAddress) {
        try {
            const requestData = {
                tx_signature: txSignature,
                expected_amount: expectedAmount,
                burner_address: burnerAddress
            };

            const response = await this.makeRequest('/api/v1/verify_burn', {
                method: 'POST',
                body: JSON.stringify(requestData)
            });

            return {
                verified: response.verified || false,
                burnAmount: response.burn_amount,
                burnTimestamp: response.burn_timestamp,
                blockHeight: response.block_height,
                confirmations: response.confirmations
            };

        } catch (error) {
            console.error('Failed to verify burn transaction:', error);
            return { verified: false, error: error.message };
        }
    }

    /**
     * Get activation status from bridge
     */
    async getActivationStatus(activationCode) {
        try {
            const response = await this.makeRequest(`/api/v1/activation_status/${activationCode}`, {
                method: 'GET'
            });

            return {
                status: response.status, // 'pending', 'verified', 'activated', 'failed'
                nodeId: response.node_id,
                activatedAt: response.activated_at,
                qnetTxHash: response.qnet_tx_hash,
                details: response.details
            };

        } catch (error) {
            console.error('Failed to get activation status:', error);
            return { status: 'unknown', error: error.message };
        }
    }

    /**
     * Get current burn pricing from bridge
     */
    async getCurrentPricing(nodeType) {
        try {
            const response = await this.makeRequest(`/api/v1/pricing/${nodeType}`, {
                method: 'GET'
            });

            return {
                nodeType,
                cost: response.cost,
                baseCost: response.base_cost,
                discount: response.discount,
                burnProgress: response.burn_progress,
                nextPriceUpdate: response.next_price_update
            };

        } catch (error) {
            console.error('Failed to get current pricing:', error);
            throw error;
        }
    }

    /**
     * Get bridge statistics
     */
    async getBridgeStats() {
        try {
            const response = await this.makeRequest('/api/v1/stats', {
                method: 'GET'
            });

            return {
                totalBurned: response.total_burned,
                totalActivations: response.total_activations,
                burnProgress: response.burn_progress,
                phaseStatus: response.phase_status,
                activeNodes: response.active_nodes,
                networkHealth: response.network_health,
                // Phase 2 stats
                totalQNCInPool3: response.total_qnc_pool3,
                phase2Activations: response.phase2_activations,
                networkSize: response.network_size
            };

        } catch (error) {
            console.error('Failed to get bridge stats:', error);
            return null;
        }
    }

    /**
     * Phase 2: Calculate required QNC amount based on network size
     */
    async calculateRequiredQNC(nodeType) {
        try {
            // Get current network size from bridge
            const stats = await this.getBridgeStats();
            const networkSize = stats?.networkSize || 0;
            
            // Determine multiplier based on network size
            let multiplier = 1.0;
            if (networkSize < 100000) {
                multiplier = this.qncActivationCosts.baseMultipliers['0-100k'];
            } else if (networkSize < 1000000) {
                multiplier = this.qncActivationCosts.baseMultipliers['100k-1m'];
            } else if (networkSize < 10000000) {
                multiplier = this.qncActivationCosts.baseMultipliers['1m-10m'];
            } else {
                multiplier = this.qncActivationCosts.baseMultipliers['10m+'];
            }
            
            // Calculate final cost
            const baseCost = this.qncActivationCosts.baseCosts[nodeType];
            const requiredQNC = Math.floor(baseCost * multiplier);
            
            return {
                nodeType,
                baseCost,
                multiplier,
                networkSize,
                requiredQNC,
                networkSizeCategory: this.getNetworkSizeCategory(networkSize)
            };
        } catch (error) {
            console.error('Failed to calculate QNC cost:', error);
            // Return base cost if calculation fails
            return {
                nodeType,
                baseCost: this.qncActivationCosts.baseCosts[nodeType] || 5000,
                multiplier: 1.0,
                requiredQNC: this.qncActivationCosts.baseCosts[nodeType] || 5000
            };
        }
    }

    /**
     * Phase 2: Start QNC activation (spend-to-Pool3)
     */
    async startPhase2Activation(eonAddress, nodeType, qncAmount) {
        try {
            // Validate inputs
            if (!['Light', 'Full', 'Super'].includes(nodeType)) {
                throw new Error('Invalid node type');
            }

            // Calculate required QNC
            const qncInfo = await this.calculateRequiredQNC(nodeType);
            
            if (qncAmount < qncInfo.requiredQNC) {
                throw new Error(`Insufficient QNC. Required: ${qncInfo.requiredQNC}, Provided: ${qncAmount}`);
            }

            const requestData = {
                eon_address: eonAddress,
                node_type: nodeType,
                qnc_amount: qncAmount,
                timestamp: Date.now(),
                activation_type: 'phase2_qnc_pool3'
            };

            console.log('Starting Phase 2 QNC activation:', requestData);

            const response = await this.makeAuthenticatedRequest('/api/v2/phase2/activate', {
                method: 'POST',
                body: JSON.stringify(requestData)
            });

            if (response.success) {
                return {
                    success: true,
                    activationId: response.activation_id,
                    nodeCode: response.node_code,
                    qncSpentToPool3: response.qnc_spent_to_pool3,
                    poolDistribution: response.pool_distribution,
                    estimatedDailyRewards: response.estimated_daily_rewards,
                    activationTimestamp: response.activation_timestamp,
                    poolTransactionHash: response.pool_tx_hash
                };
            } else {
                throw new Error(response.error || 'Phase 2 activation failed');
            }

        } catch (error) {
            console.error('Phase 2 activation failed:', error);
            throw error;
        }
    }

    /**
     * Phase 2: Get Pool 3 information
     */
    async getPool3Info() {
        try {
            const response = await this.makeRequest('/api/v2/pool3/info', {
                method: 'GET'
            });

            return {
                totalQNCInPool: response.total_qnc,
                activeNodes: response.active_nodes,
                dailyDistributionAmount: response.daily_distribution,
                rewardsPerActiveNode: response.rewards_per_node,
                lastDistributionTime: response.last_distribution,
                nextDistributionTime: response.next_distribution,
                poolGrowthRate: response.pool_growth_rate
            };

        } catch (error) {
            console.error('Failed to get Pool 3 info:', error);
            return null;
        }
    }

    /**
     * Get current phase information
     */
    async getCurrentPhase() {
        try {
            const response = await this.makeRequest('/api/v2/phase/current', {
                method: 'GET'
            });

            return {
                currentPhase: response.current_phase,
                phase1Active: response.phase1_active,
                phase2Active: response.phase2_active,
                transitionTimestamp: response.transition_timestamp,
                networkReadiness: response.network_readiness
            };

        } catch (error) {
            console.error('Failed to get current phase:', error);
            return {
                currentPhase: 1,
                phase1Active: true,
                phase2Active: false
            };
        }
    }

    /**
     * Submit QNet activation proof
     */
    async submitQNetActivation(activationCode, qnetTxHash, nodeAddress) {
        try {
            const requestData = {
                activation_code: activationCode,
                qnet_tx_hash: qnetTxHash,
                node_address: nodeAddress,
                timestamp: Date.now()
            };

            const response = await this.makeRequest('/api/v1/submit_qnet_activation', {
                method: 'POST',
                body: JSON.stringify(requestData)
            });

            return {
                success: response.success,
                bridgeConfirmed: response.bridge_confirmed,
                crossChainVerified: response.cross_chain_verified
            };

        } catch (error) {
            console.error('Failed to submit QNet activation:', error);
            throw error;
        }
    }

    /**
     * Get activation history for address
     */
    async getActivationHistory(address, network = 'both') {
        try {
            const response = await this.makeRequest(`/api/v1/activation_history/${address}`, {
                method: 'GET',
                headers: {
                    'X-Network-Filter': network
                }
            });

            return response.activations?.map(activation => ({
                activationCode: activation.activation_code,
                nodeType: activation.node_type,
                burnAmount: activation.burn_amount,
                solanaSignature: activation.solana_signature,
                qnetTxHash: activation.qnet_tx_hash,
                status: activation.status,
                createdAt: activation.created_at,
                activatedAt: activation.activated_at
            })) || [];

        } catch (error) {
            console.error('Failed to get activation history:', error);
            return [];
        }
    }

    /**
     * Check bridge health
     */
    async checkBridgeHealth() {
        try {
            const response = await this.makeRequest('/api/v1/health', {
                method: 'GET'
            });

            return {
                healthy: response.status === 'healthy',
                solanaConnected: response.solana_connected,
                qnetConnected: response.qnet_connected,
                lastUpdate: response.last_update,
                version: response.version
            };

        } catch (error) {
            console.error('Failed to check bridge health:', error);
            return {
                healthy: false,
                error: error.message
            };
        }
    }

    /**
     * Get supported node types and their requirements
     */
    async getSupportedNodeTypes() {
        try {
            const response = await this.makeRequest('/api/v1/node_types', {
                method: 'GET'
            });

            return response.node_types?.map(type => ({
                type: type.type,
                name: type.name,
                description: type.description,
                requirements: type.requirements,
                currentCost: type.current_cost,
                baseCost: type.base_cost
            })) || [];

        } catch (error) {
            console.error('Failed to get supported node types:', error);
            return [];
        }
    }

    /**
     * Authenticate wallet with bridge
     */
    async authenticateWallet(walletAddress, signature) {
        try {
            const requestData = {
                address: walletAddress,
                signature: signature,
                timestamp: Date.now()
            };

            const response = await this.makeRequest('/api/auth/wallet', {
                method: 'POST',
                body: JSON.stringify(requestData)
            });

            if (response.success && response.token) {
                this.authToken = {
                    token: response.token,
                    expires: response.expires,
                    address: walletAddress
                };
                return true;
            } else {
                throw new Error(response.error || 'Authentication failed');
            }
        } catch (error) {
            console.error('Wallet authentication failed:', error);
            throw error;
        }
    }

    /**
     * Make authenticated request to bridge API
     */
    async makeAuthenticatedRequest(endpoint, options = {}) {
        if (!this.authToken || this.isTokenExpired()) {
            throw new Error('No valid authentication token. Please authenticate first.');
        }

        const headers = {
            'Authorization': `Bearer ${this.authToken.token}`,
            ...options.headers
        };

        return await this.makeRequest(endpoint, {
            ...options,
            headers
        });
    }

    /**
     * Check if auth token is expired
     */
    isTokenExpired() {
        if (!this.authToken || !this.authToken.expires) {
            return true;
        }
        return Date.now() > this.authToken.expires;
    }

    /**
     * 1dev-burn-contract: Get Phase 1 burn contract information
     */
    async get1DEVBurnContractInfo() {
        try {
            const response = await this.makeRequest('/api/v1/1dev_burn_contract/info', {
                method: 'GET'
            });

            return {
                contractAddress: response.contract_address,
                total1DEVBurned: response.total_1dev_burned,
                burnEvents: response.burn_events,
                isActive: response.is_active,
                currentBurnPrice: response.current_burn_price,
                minimumBurnAmount: response.minimum_burn_amount,
                dynamicPricing: response.dynamic_pricing
            };
        } catch (error) {
            console.error('Failed to get 1DEV burn contract info:', error);
            return null;
        }
    }

    /**
     * 1dev-burn-contract: Verify 1DEV burn with contract
     */
    async verify1DEVBurnWithContract(txSignature, expectedAmount, tokenMint) {
        try {
            const requestData = {
                tx_signature: txSignature,
                expected_amount: expectedAmount,
                token_mint: tokenMint, // 1DEV token mint
                contract_address: this.burnContractAddress
            };

            const response = await this.makeRequest('/api/v1/1dev_burn_contract/verify', {
                method: 'POST',
                body: JSON.stringify(requestData)
            });

            return {
                verified: response.verified,
                burnAmount: response.burn_amount,
                burnTimestamp: response.burn_timestamp,
                contractConfirmed: response.contract_confirmed,
                blockConfirmations: response.block_confirmations,
                burnEventId: response.burn_event_id,
                dynamicPrice: response.dynamic_price
            };
        } catch (error) {
            console.error('Failed to verify 1DEV burn with contract:', error);
            return { verified: false, error: error.message };
        }
    }

    /**
     * Get network size category for multiplier calculation
     */
    getNetworkSizeCategory(networkSize) {
        if (networkSize < 100000) return '0-100k';
        if (networkSize < 1000000) return '100k-1m';
        if (networkSize < 10000000) return '1m-10m';
        return '10m+';
    }

    /**
     * Set bridge endpoint (testnet/mainnet/local)
     */
    setBridgeEndpoint(environment) {
        if (this.bridgeEndpoints[environment]) {
            this.currentEndpoint = this.bridgeEndpoints[environment];
            console.log(`Bridge endpoint set to: ${this.currentEndpoint}`);
        } else {
            throw new Error(`Invalid bridge environment: ${environment}`);
        }
    }

    /**
     * Make HTTP request to bridge API
     */
    async makeRequest(endpoint, options = {}) {
        const url = `${this.currentEndpoint}${endpoint}`;
        
        const defaultOptions = {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'QNet-Wallet/2.0.0',
                'X-Client-Type': 'desktop'
            },
            timeout: this.timeout
        };

        const requestOptions = {
            ...defaultOptions,
            ...options,
            headers: {
                ...defaultOptions.headers,
                ...options.headers
            }
        };

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeout);

            const response = await fetch(url, {
                ...requestOptions,
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            // Handle authentication errors
            if (response.status === 401) {
                this.authToken = null;
                throw new Error('Authentication expired');
            }

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP ${response.status}: ${errorText}`);
            }

            const data = await response.json();
            return data;

        } catch (error) {
            if (error.name === 'AbortError') {
                throw new Error('Request timeout');
            }
            throw error;
        }
    }

    /**
     * Set bridge URL (deprecated - use setBridgeEndpoint instead)
     */
    setBridgeUrl(url) {
        console.warn('setBridgeUrl is deprecated. Use setBridgeEndpoint("testnet"/"mainnet"/"local") instead.');
        this.currentEndpoint = url;
    }

    /**
     * Set request timeout
     */
    setTimeout(timeout) {
        this.timeout = timeout;
    }

    /**
     * Generate activation request ID
     */
    generateRequestId() {
        return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Validate activation code format
     */
    validateActivationCode(code) {
        // QNet activation codes format: QNET-XXXXXX-YYYYYY
        const pattern = /^QNET-[A-Z0-9]{6}-[A-Z0-9]{6}$/;
        return pattern.test(code);
    }

    /**
     * Parse activation code
     */
    parseActivationCode(code) {
        if (!this.validateActivationCode(code)) {
            return null;
        }

        const parts = code.split('-');
        return {
            prefix: parts[0], // 'QNET'
            nodeId: parts[1], // 6-character node ID
            checksum: parts[2] // 6-character checksum
        };
    }

    /**
     * Monitor activation progress
     */
    async monitorActivation(activationCode, onProgress, maxAttempts = 30) {
        let attempts = 0;
        
        const checkStatus = async () => {
            try {
                const status = await this.getActivationStatus(activationCode);
                
                if (onProgress) {
                    onProgress(status);
                }

                if (status.status === 'activated' || status.status === 'failed') {
                    return status;
                }

                attempts++;
                if (attempts >= maxAttempts) {
                    throw new Error('Activation monitoring timeout');
                }

                // Wait 2 seconds before next check
                await new Promise(resolve => setTimeout(resolve, 2000));
                return await checkStatus();

            } catch (error) {
                console.error('Error monitoring activation:', error);
                throw error;
            }
        };

        return await checkStatus();
    }
} 