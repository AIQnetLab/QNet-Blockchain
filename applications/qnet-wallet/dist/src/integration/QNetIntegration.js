/**
 * QNet Blockchain Integration for QNet Wallet
 * Handles QNet network operations, node activation, and QNC management
 */

export class QNetIntegration {
    constructor(networkManager) {
        this.networkManager = networkManager;
        this.rpcUrl = null;
        this.qncDecimals = 9; // QNC token decimals
    }

    /**
     * Initialize QNet integration
     */
    async initialize() {
        this.rpcUrl = this.networkManager.getQNetRPC();
        if (!this.rpcUrl) {
            throw new Error('QNet RPC URL not available');
        }
    }

    /**
     * Get QNC balance for address
     */
    async getQNCBalance(address) {
        try {
            const response = await this.makeRPCCall('get_balance', {
                address: address,
                token: 'QNC'
            });

            return response.balance / Math.pow(10, this.qncDecimals);
        } catch (error) {
            console.error('Failed to get QNC balance:', error);
            return 0;
        }
    }

    /**
     * Activate node with activation code (Phase 1)
     */
    async activateNodeWithCode(activationCode, ownerAddress) {
        try {
            const response = await this.makeRPCCall('activate_node', {
                activation_code: activationCode,
                owner: ownerAddress,
                timestamp: Date.now()
            });

            return {
                success: response.success,
                nodeId: response.node_id,
                txHash: response.tx_hash,
                activatedAt: response.activated_at,
                nodeType: response.node_type
            };

        } catch (error) {
            console.error('Failed to activate node with code:', error);
            throw error;
        }
    }

    /**
     * Activate node with QNC (Phase 2)
     */
    async activateNodeWithQNC(nodeType, amount, ownerAddress, privateKey) {
        try {
            // First send QNC to Pool 3
            const poolTx = await this.sendQNCToPool3(amount, nodeType, ownerAddress, privateKey);
            
            // Then activate node using pool transaction
            const activationTx = await this.makeRPCCall('activate_node_phase2', {
                node_type: nodeType,
                pool_tx_hash: poolTx.txHash,
                qnc_amount: amount,
                owner: ownerAddress,
                timestamp: Date.now()
            });

            return {
                success: true,
                nodeId: activationTx.node_id,
                txHash: activationTx.tx_hash,
                poolTxHash: poolTx.txHash,
                activatedAt: activationTx.activated_at,
                nodeType: nodeType,
                qncUsed: amount
            };

        } catch (error) {
            console.error('Failed to activate node with QNC:', error);
            throw error;
        }
    }

    /**
     * Send QNC to Pool 3 for redistribution
     */
    async sendQNCToPool3(amount, nodeType, fromAddress, privateKey) {
        try {
            const amountInUnits = Math.floor(amount * Math.pow(10, this.qncDecimals));

            const response = await this.makeRPCCall('send_to_pool3', {
                amount: amountInUnits,
                node_type: nodeType,
                from: fromAddress,
                private_key: privateKey, // In production, this would be signed client-side
                timestamp: Date.now()
            });

            return {
                success: response.success,
                txHash: response.tx_hash,
                amount: amount,
                poolDistribution: response.pool_distribution
            };

        } catch (error) {
            console.error('Failed to send QNC to Pool 3:', error);
            throw error;
        }
    }

    /**
     * Get node status and information
     */
    async getNodeStatus(nodeIdOrCode) {
        try {
            const response = await this.makeRPCCall('get_node_status', {
                node_identifier: nodeIdOrCode
            });

            return {
                nodeId: response.node_id,
                nodeType: response.node_type,
                status: response.status, // 'active', 'inactive', 'slashed'
                owner: response.owner,
                activatedAt: response.activated_at,
                lastPing: response.last_ping,
                reputation: response.reputation,
                totalRewards: response.total_rewards,
                activationMethod: response.activation_method, // 'code' or 'qnc'
                uptime: response.uptime
            };

        } catch (error) {
            console.error('Failed to get node status:', error);
            return null;
        }
    }

    /**
     * Get activation costs for current network size
     */
    async getActivationCosts() {
        try {
            const response = await this.makeRPCCall('get_activation_costs', {});

            return {
                light: response.costs.light,
                full: response.costs.full,
                super: response.costs.super,
                networkSize: response.network_size,
                multiplier: response.multiplier,
                baseCosts: response.base_costs
            };

        } catch (error) {
            console.error('Failed to get activation costs:', error);
            // PRODUCTION: Return error state, NOT fake prices
            return {
                light: null,
                full: null,
                super: null,
                networkSize: null,
                multiplier: null,
                error: 'Activation costs unavailable - API unreachable',
                unavailable: true
            };
        }
    }

    /**
     * Migrate device (same wallet, different device)
     */
    async migrateDevice(nodeId, walletAddress, newDeviceSignature, privateKey) {
        try {
            const response = await this.makeRPCCall('migrate_device', {
                node_id: nodeId,
                wallet_address: walletAddress,
                new_device_signature: newDeviceSignature,
                private_key: privateKey,
                timestamp: Date.now()
            });

            return {
                success: response.success,
                txHash: response.tx_hash,
                migratedAt: response.migrated_at
            };

        } catch (error) {
            console.error('Failed to migrate device:', error);
            throw error;
        }
    }

    /**
     * Get nodes for device signature
     */
    async getDeviceNodes(deviceSignature) {
        try {
            const response = await this.makeRPCCall('get_device_nodes', {
                device_signature: deviceSignature
            });

            return response.nodes || [];

        } catch (error) {
            console.error('Failed to get device nodes:', error);
            return [];
        }
    }

    /**
     * Get wallet's active nodes
     */
    async getWalletNodes(address) {
        try {
            const response = await this.makeRPCCall('get_wallet_nodes', {
                wallet: address
            });

            return response.nodes?.map(node => ({
                nodeId: node.node_id,
                nodeType: node.node_type,
                status: node.status,
                activatedAt: node.activated_at,
                lastPing: node.last_ping,
                reputation: node.reputation,
                totalRewards: node.total_rewards
            })) || [];

        } catch (error) {
            console.error('Failed to get wallet nodes:', error);
            return [];
        }
    }

    /**
     * Send QNC transaction
     */
    async sendQNC(fromAddress, toAddress, amount, privateKey, memo = '') {
        try {
            const amountInUnits = Math.floor(amount * Math.pow(10, this.qncDecimals));

            const response = await this.makeRPCCall('send_qnc', {
                from: fromAddress,
                to: toAddress,
                amount: amountInUnits,
                memo: memo,
                private_key: privateKey,
                timestamp: Date.now()
            });

            return {
                success: response.success,
                txHash: response.tx_hash,
                amount: amount,
                fee: response.fee,
                confirmedAt: response.confirmed_at
            };

        } catch (error) {
            console.error('Failed to send QNC:', error);
            throw error;
        }
    }

    /**
     * Get transaction history
     */
    async getTransactionHistory(address, limit = 20) {
        try {
            const response = await this.makeRPCCall('get_transaction_history', {
                address: address,
                limit: limit
            });

            return response.transactions?.map(tx => ({
                txHash: tx.tx_hash,
                type: tx.type, // 'send', 'receive', 'activation', 'reward'
                amount: tx.amount / Math.pow(10, this.qncDecimals),
                from: tx.from,
                to: tx.to,
                timestamp: tx.timestamp,
                status: tx.status,
                memo: tx.memo
            })) || [];

        } catch (error) {
            console.error('Failed to get transaction history:', error);
            return [];
        }
    }

    /**
     * Get current network phase
     */
    async getCurrentPhase() {
        try {
            const response = await this.makeRPCCall('get_network_phase', {});

            return {
                phase: response.phase, // 1 or 2
                burnProgress: response.burn_progress,
                networkAge: response.network_age,
                transitionCriteria: response.transition_criteria
            };

        } catch (error) {
            console.error('Failed to get current phase:', error);
            return { phase: 1 }; // Default to Phase 1
        }
    }

    /**
     * Get Pool 3 statistics
     */
    async getPool3Stats() {
        try {
            const response = await this.makeRPCCall('get_pool3_stats', {});

            return {
                totalBalance: response.total_balance / Math.pow(10, this.qncDecimals),
                totalDistributed: response.total_distributed / Math.pow(10, this.qncDecimals),
                activeNodes: response.active_nodes,
                lastDistribution: response.last_distribution,
                nextDistribution: response.next_distribution,
                distributionRate: response.distribution_rate
            };

        } catch (error) {
            console.error('Failed to get Pool 3 stats:', error);
            return null;
        }
    }

    /**
     * Get node rewards information
     */
    async getNodeRewards(nodeId) {
        try {
            const response = await this.makeRPCCall('get_node_rewards', {
                node_id: nodeId
            });

            return {
                totalEarned: response.total_earned / Math.pow(10, this.qncDecimals),
                pool1Rewards: response.pool1_rewards / Math.pow(10, this.qncDecimals),
                pool2Rewards: response.pool2_rewards / Math.pow(10, this.qncDecimals),
                pool3Rewards: response.pool3_rewards / Math.pow(10, this.qncDecimals),
                lastReward: response.last_reward,
                nextReward: response.next_reward,
                rewardRate: response.reward_rate
            };

        } catch (error) {
            console.error('Failed to get node rewards:', error);
            return null;
        }
    }

    /**
     * Ping node (for reputation maintenance)
     */
    async pingNode(nodeId, ownerAddress, privateKey) {
        try {
            const response = await this.makeRPCCall('ping_node', {
                node_id: nodeId,
                owner: ownerAddress,
                private_key: privateKey,
                timestamp: Date.now()
            });

            return {
                success: response.success,
                reputation: response.reputation,
                nextPingWindow: response.next_ping_window
            };

        } catch (error) {
            console.error('Failed to ping node:', error);
            throw error;
        }
    }

    /**
     * Get network statistics
     */
    async getNetworkStats() {
        try {
            const response = await this.makeRPCCall('get_network_stats', {});

            return {
                totalNodes: response.total_nodes,
                activeNodes: response.active_nodes,
                lightNodes: response.light_nodes,
                fullNodes: response.full_nodes,
                superNodes: response.super_nodes,
                totalSupply: response.total_supply / Math.pow(10, this.qncDecimals),
                circulatingSupply: response.circulating_supply / Math.pow(10, this.qncDecimals),
                networkHashrate: response.network_hashrate,
                avgBlockTime: response.avg_block_time
            };

        } catch (error) {
            console.error('Failed to get network stats:', error);
            return null;
        }
    }

    /**
     * Batch claim rewards for multiple nodes
     */
    async batchClaimRewards(nodeIds, ownerAddress) {
        try {
            const response = await this.makeRPCCall('batch/claim-rewards', {
                node_ids: nodeIds,
                owner_address: ownerAddress
            }, 'POST');

            return {
                success: response.success,
                batchId: response.batch_id,
                totalClaimed: response.total_claimed,
                processedNodes: response.processed_nodes,
                gasSaved: response.gas_saved,
                results: response.results
            };

        } catch (error) {
            console.error('Failed to batch claim rewards:', error);
            throw error;
        }
    }

    /**
     * Batch activate multiple nodes
     */
    async batchActivateNodes(activations, ownerAddress) {
        try {
            const response = await this.makeRPCCall('batch/activate-nodes', {
                activations: activations,
                owner_address: ownerAddress
            }, 'POST');

            return {
                success: response.success,
                batchId: response.batch_id,
                totalCost: response.total_cost,
                activatedNodes: response.activated_nodes,
                gasSaved: response.gas_saved,
                results: response.results
            };

        } catch (error) {
            console.error('Failed to batch activate nodes:', error);
            throw error;
        }
    }

    /**
     * Batch transfer QNC to multiple addresses
     */
    async batchTransfer(transfers, fromAddress) {
        try {
            const response = await this.makeRPCCall('batch/transfer', {
                transfers: transfers,
                from_address: fromAddress
            }, 'POST');

            return {
                success: response.success,
                batchId: response.batch_id,
                totalAmount: response.total_amount,
                processedTransfers: response.processed_transfers,
                gasSaved: response.gas_saved,
                results: response.results
            };

        } catch (error) {
            console.error('Failed to batch transfer:', error);
            throw error;
        }
    }

    /**
     * Get batch operation metrics
     */
    async getBatchMetrics() {
        try {
            const response = await this.makeRPCCall('batch/metrics');
            return response.metrics;
        } catch (error) {
            console.error('Failed to get batch metrics:', error);
            throw error;
        }
    }

    /**
     * Get batch operation status
     */
    async getBatchStatus(batchId) {
        try {
            const response = await this.makeRPCCall(`batch/status/${batchId}`);
            return response;
        } catch (error) {
            console.error('Failed to get batch status:', error);
            throw error;
        }
    }

    /**
     * Get mobile gas recommendations
     */
    async getMobileGasRecommendations() {
        try {
            const response = await this.makeRPCCall('mobile/gas-recommendations');
            return response.recommendations;
        } catch (error) {
            console.error('Failed to get mobile gas recommendations:', error);
            throw error;
        }
    }

    /**
     * Get mobile network status
     */
    async getMobileNetworkStatus() {
        try {
            const response = await this.makeRPCCall('mobile/network-status');
            return response.network;
        } catch (error) {
            console.error('Failed to get mobile network status:', error);
            throw error;
        }
    }

    /**
     * Get mobile-optimized transaction cost estimate
     */
    async estimateTransactionCost(transactionType, gasTier = 'standard', amount = 0) {
        try {
            const response = await this.makeRPCCall('mobile/estimate-transaction-cost', {
                type: transactionType,
                gas_tier: gasTier,
                amount: amount
            }, 'POST');

            return response.estimate;
        } catch (error) {
            console.error('Failed to estimate transaction cost:', error);
            throw error;
        }
    }

    /**
     * Get batch operation cost comparison
     */
    async estimateBatchCost(operations, gasTier = 'standard') {
        try {
            const response = await this.makeRPCCall('mobile/batch-estimate', {
                operations: operations,
                gas_tier: gasTier
            }, 'POST');

            return response.estimate;
        } catch (error) {
            console.error('Failed to estimate batch cost:', error);
            throw error;
        }
    }

    /**
     * Enhanced RPC call with mobile optimization
     */
    async makeRPCCall(method, params = {}, httpMethod = 'GET') {
        try {
            const apiUrl = this.rpcUrl || 'http://localhost:5000';
            const endpoint = `${apiUrl}/api/v1/${method}`;
            
            const options = {
                method: httpMethod,
                headers: {
                    'Content-Type': 'application/json',
                    'X-Wallet-Type': 'QNetWallet',
                    'X-Mobile-Optimized': 'true'
                }
            };

            if (httpMethod === 'POST' || httpMethod === 'PUT') {
                options.body = JSON.stringify(params);
            }

            const response = await fetch(endpoint, options);
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            return await response.json();

        } catch (error) {
            console.error(`RPC call failed for ${method}:`, error);
            throw error;
        }
    }

    /**
     * Validate QNet address format
     */
    validateAddress(address) {
        // EON address format validation
        if (!address || typeof address !== 'string') {
            return false;
        }

        // Check new EON format: 19 chars + "eon" + 15 chars + 4 char checksum = 41 total
        if (address.length === 41 && address.substring(19, 22) === 'eon') {
            return true;
        }

        // Legacy qnet1 format support
        if (address.startsWith('qnet1') && address.length >= 37 && address.length <= 49) {
            return true;
        }

        return false;
    }

    /**
     * Get address information
     */
    async getAddressInfo(address) {
        try {
            const response = await this.makeRPCCall('get_address_info', {
                address: address
            });

            return {
                address: response.address,
                balance: response.balance / Math.pow(10, this.qncDecimals),
                nonce: response.nonce,
                isContract: response.is_contract,
                createdAt: response.created_at,
                lastActivity: response.last_activity
            };

        } catch (error) {
            console.error('Failed to get address info:', error);
            return null;
        }
    }

    /**
     * Estimate transaction fee
     */
    async estimateFee(operation, params) {
        try {
            const response = await this.makeRPCCall('estimate_fee', {
                operation: operation,
                params: params
            });

            return response.fee / Math.pow(10, this.qncDecimals);

        } catch (error) {
            console.error('Failed to estimate fee:', error);
            return 0.001; // Default fee estimate
        }
    }
} 