// QNet Network Manager

export class NetworkManager {
    constructor() {
        this.baseUrl = 'https://api.qnet.network';
        this.fallbackUrls = [
            'https://bridge.qnet.io',
            'https://testnet-bridge.qnet.io',
            'http://localhost:5000'
        ];
        this.timeout = 30000;
        this.retryAttempts = 3;
        this.currentUrl = this.baseUrl;
        
        // Phase-aware reward system
        this.currentPhase = 1;
        this.lastPhaseCheck = 0;
        this.phaseCheckInterval = 60000; // Check phase every minute
    }
    
    async makeRequest(endpoint, options = {}) {
        const urls = [this.currentUrl, ...this.fallbackUrls];
        
        for (let i = 0; i < urls.length; i++) {
            const url = urls[i];
            
            try {
                const response = await fetch(`${url}${endpoint}`, {
                    timeout: this.timeout,
                    ...options
                });
                
                if (response.ok) {
                    this.currentUrl = url; // Update current URL on success
                    return await response.json();
                } else {
                    console.warn(`Request failed for ${url}${endpoint}:`, response.status);
                }
            } catch (error) {
                console.warn(`Network error for ${url}${endpoint}:`, error.message);
                
                if (i === urls.length - 1) {
                    throw new Error(`All network endpoints failed. Last error: ${error.message}`);
                }
            }
        }
    }
    
    // Get current network phase
    async getCurrentPhase() {
        try {
            const response = await this.makeRequest('/api/v1/network/phase');
            this.currentPhase = response.phase || 1;
            this.lastPhaseCheck = Date.now();
            return this.currentPhase;
        } catch (error) {
            console.error('Error getting current phase:', error);
            return this.currentPhase; // Return cached value
        }
    }
    
    // Get node rewards with three-pool breakdown
    async getNodeRewards(nodeId) {
        try {
            const response = await this.makeRequest(`/api/v1/rewards/${nodeId}`);
            
            // Ensure we have three-pool breakdown
            return {
                unclaimed: response.unclaimed || 0,
                pool1_base: response.pool1_base || 0,
                pool2_fees: response.pool2_fees || 0,
                pool3_activation: response.pool3_activation || 0,
                total_earned: response.total_earned || 0,
                last_claim: response.last_claim || 'Never',
                current_phase: response.current_phase || this.currentPhase,
                ping_success_rate: response.ping_success_rate || 0,
                meets_ping_requirements: response.meets_ping_requirements || false,
                ping_history: response.ping_history || [],
                reward_breakdown: response.reward_breakdown || {
                    pool1_description: 'Base emission (equal to all active nodes)',
                    pool2_description: 'Transaction fees (70% Super, 30% Full, 0% Light)',
                    pool3_description: 'Activation pool (Phase 2 only, equal to all active nodes)'
                }
            };
        } catch (error) {
            console.error('Error getting node rewards:', error);
            throw error;
        }
    }
    
    // Claim node rewards (lazy claim system)
    async claimNodeRewards(nodeId, ownerAddress, amount) {
        try {
            const response = await this.makeRequest(`/api/v1/rewards/claim`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    nodeId,
                    ownerAddress,
                    amount,
                    timestamp: Date.now()
                })
            });
            
            if (response.success) {
                return {
                    amount: response.claimed_amount || amount,
                    tx_hash: response.tx_hash || `claim_${Date.now()}`,
                    pool_breakdown: response.pool_breakdown || {
                        pool1_base: 0,
                        pool2_fees: 0,
                        pool3_activation: 0
                    }
                };
            } else {
                throw new Error(response.error || 'Claim failed');
            }
        } catch (error) {
            console.error('Error claiming rewards:', error);
            throw error;
        }
    }
    
    // Report ping result for reward eligibility
    async reportPingResult(nodeId, success, responseTime) {
        try {
            const response = await this.makeRequest(`/api/v1/ping/report`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    nodeId,
                    success,
                    responseTime,
                    timestamp: Date.now()
                })
            });
            
            return response;
        } catch (error) {
            console.error('Error reporting ping result:', error);
            throw error;
        }
    }
    
    // Get transaction fee distribution info
    async getTransactionFeeDistribution() {
        try {
            const response = await this.makeRequest('/api/v1/rewards/fee-distribution');
            
            return {
                pool2_total: response.pool2_total || 0,
                distribution: {
                    super_nodes: response.super_nodes || { percentage: 70, amount: 0 },
                    full_nodes: response.full_nodes || { percentage: 30, amount: 0 },
                    light_nodes: response.light_nodes || { percentage: 0, amount: 0 }
                },
                last_distribution: response.last_distribution || 'Never',
                next_distribution: response.next_distribution || 'Unknown'
            };
        } catch (error) {
            console.error('Error getting fee distribution:', error);
            throw error;
        }
    }
    
    // Get Pool 3 activation info (Phase 2 only)
    async getPool3Info() {
        try {
            const response = await this.makeRequest('/api/v1/rewards/pool3');
            
            return {
                enabled: response.enabled || false,
                current_phase: response.current_phase || this.currentPhase,
                total_pool: response.total_pool || 0,
                recent_activations: response.recent_activations || [],
                next_distribution: response.next_distribution || 'Unknown',
                activation_costs: response.activation_costs || {
                    light: 5000,
                    full: 7500,
                    super: 10000
                }
            };
        } catch (error) {
            console.error('Error getting Pool 3 info:', error);
            throw error;
        }
    }
    
    // Submit transaction fees to Pool 2
    async submitTransactionFee(amount, txHash) {
        try {
            const response = await this.makeRequest('/api/v1/rewards/add-fee', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    amount,
                    txHash,
                    timestamp: Date.now()
                })
            });
            
            return response;
        } catch (error) {
            console.error('Error submitting transaction fee:', error);
            throw error;
        }
    }
    
    // Add QNC to Pool 3 (Phase 2 only)
    async addQNCToPool3(amount, activationTxHash) {
        try {
            const currentPhase = await this.getCurrentPhase();
            
            if (currentPhase < 2) {
                throw new Error('Pool 3 disabled in Phase 1. Use 1DEV burn instead.');
            }
            
            const response = await this.makeRequest('/api/v1/rewards/add-pool3', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    amount,
                    activationTxHash,
                    timestamp: Date.now(),
                    phase: currentPhase
                })
            });
            
            return response;
        } catch (error) {
            console.error('Error adding QNC to Pool 3:', error);
            throw error;
        }
    }
    
    // Get Base emission info (Pool 1)
    async getBaseEmissionInfo() {
        try {
            const response = await this.makeRequest('/api/v1/rewards/base-emission');
            
            return {
                current_rate: response.current_rate || 245100.67,
                next_halving: response.next_halving || 'Unknown',
                years_since_genesis: response.years_since_genesis || 0,
                halving_cycle: response.halving_cycle || 0,
                sharp_drop_active: response.sharp_drop_active || false,
                emission_schedule: response.emission_schedule || []
            };
        } catch (error) {
            console.error('Error getting base emission info:', error);
            throw error;
        }
    }
    
    // Get comprehensive reward statistics
    async getRewardStatistics() {
        try {
            const [pool1Info, pool2Info, pool3Info] = await Promise.all([
                this.getBaseEmissionInfo(),
                this.getTransactionFeeDistribution(),
                this.getPool3Info()
            ]);
            
            return {
                phase: this.currentPhase,
                pool1_base_emission: pool1Info,
                pool2_transaction_fees: pool2Info,
                pool3_activation_pool: pool3Info,
                total_rewards_available: (pool1Info.current_rate || 0) + (pool2Info.pool2_total || 0) + (pool3Info.total_pool || 0),
                last_updated: Date.now()
            };
        } catch (error) {
            console.error('Error getting reward statistics:', error);
            throw error;
        }
    }
    
    // Get node status
    async getNodeStatus(nodeId) {
        try {
            const response = await this.makeRequest(`/api/v1/node/${nodeId}/status`);
            
            return {
                status: response.status || 'unknown',
                connected: response.connected || false,
                peers: response.peers || 0,
                lastPing: response.lastPing || 'Never',
                uptime: response.uptime || 0,
                version: response.version || 'Unknown'
            };
        } catch (error) {
            console.error('Error getting node status:', error);
            throw error;
        }
    }
    
    // Legacy methods for backward compatibility
    async getNodeInfo(nodeId) {
        try {
            const [status, rewards] = await Promise.all([
                this.getNodeStatus(nodeId),
                this.getNodeRewards(nodeId)
            ]);
            
            return {
                ...status,
                pendingRewards: rewards.unclaimed,
                totalEarned: rewards.total_earned,
                rewardBreakdown: {
                    pool1: rewards.pool1_base,
                    pool2: rewards.pool2_fees,
                    pool3: rewards.pool3_activation
                }
            };
        } catch (error) {
            console.error('Error getting node info:', error);
            throw error;
        }
    }

    // Batch operations support
    async batchClaimRewards(nodeIds, ownerAddress) {
        try {
            const response = await this.makeRequest('/api/v1/batch/claim-rewards', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    node_ids: nodeIds,
                    owner_address: ownerAddress
                })
            });

            return {
                success: response.success,
                batchId: response.batch_id,
                totalClaimed: response.total_claimed,
                processedNodes: response.processed_nodes,
                gasSaved: response.gas_saved,
                results: response.results
            };

        } catch (error) {
            console.error('Batch claim rewards failed:', error);
            throw error;
        }
    }

    async batchActivateNodes(activations, ownerAddress) {
        try {
            const response = await this.makeRequest('/api/v1/batch/activate-nodes', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    activations: activations,
                    owner_address: ownerAddress
                })
            });

            return {
                success: response.success,
                batchId: response.batch_id,
                totalCost: response.total_cost,
                activatedNodes: response.activated_nodes,
                gasSaved: response.gas_saved,
                results: response.results
            };

        } catch (error) {
            console.error('Batch activate nodes failed:', error);
            throw error;
        }
    }

    async batchTransfer(transfers, fromAddress) {
        try {
            const response = await this.makeRequest('/api/v1/batch/transfer', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    transfers: transfers,
                    from_address: fromAddress
                })
            });

            return {
                success: response.success,
                batchId: response.batch_id,
                totalAmount: response.total_amount,
                processedTransfers: response.processed_transfers,
                gasSaved: response.gas_saved,
                results: response.results
            };

        } catch (error) {
            console.error('Batch transfer failed:', error);
            throw error;
        }
    }

    // Mobile API support
    async getMobileGasRecommendations() {
        try {
            const response = await this.makeRequest('/api/v1/mobile/gas-recommendations');
            return response.recommendations;
        } catch (error) {
            console.error('Error getting mobile gas recommendations:', error);
            throw error;
        }
    }

    async getMobileNetworkStatus() {
        try {
            const response = await this.makeRequest('/api/v1/mobile/network-status');
            return response.network;
        } catch (error) {
            console.error('Error getting mobile network status:', error);
            throw error;
        }
    }

    async estimateTransactionCost(transactionType, gasTier = 'standard', amount = 0) {
        try {
            const response = await this.makeRequest('/api/v1/mobile/estimate-transaction-cost', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    type: transactionType,
                    gas_tier: gasTier,
                    amount: amount
                })
            });

            return response.estimate;
        } catch (error) {
            console.error('Error estimating transaction cost:', error);
            throw error;
        }
    }

    async estimateBatchCost(operations, gasTier = 'standard') {
        try {
            const response = await this.makeRequest('/api/v1/mobile/batch-estimate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    operations: operations,
                    gas_tier: gasTier
                })
            });

            return response.estimate;
        } catch (error) {
            console.error('Error estimating batch cost:', error);
            throw error;
        }
    }

    // Enhanced batch metrics tracking
    async getBatchMetrics() {
        try {
            const response = await this.makeRequest('/api/v1/batch/metrics');
            return response.metrics;
        } catch (error) {
            console.error('Error getting batch metrics:', error);
            throw error;
        }
    }

    async getBatchStatus(batchId) {
        try {
            const response = await this.makeRequest(`/api/v1/batch/status/${batchId}`);
            return response;
        } catch (error) {
            console.error('Error getting batch status:', error);
            throw error;
        }
    }
} 