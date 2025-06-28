/**
 * Activation Bridge Client for QNet Wallet
 * Handles communication with the activation bridge API for cross-chain operations
 */

export class ActivationBridgeClient {
    constructor(networkManager) {
        this.networkManager = networkManager;
        this.bridgeUrl = 'http://localhost:5000'; // Activation bridge API URL
        this.timeout = 30000; // 30 second timeout
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
                networkHealth: response.network_health
            };

        } catch (error) {
            console.error('Failed to get bridge stats:', error);
            return null;
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
     * Make HTTP request to bridge API
     */
    async makeRequest(endpoint, options = {}) {
        const url = `${this.bridgeUrl}${endpoint}`;
        
        const defaultOptions = {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'QNet-Wallet/1.0.0'
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
     * Set bridge URL
     */
    setBridgeUrl(url) {
        this.bridgeUrl = url;
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