/**
 * Node Ownership Manager for QNet Wallet
 * Manages node ownership verification and transfer with blockchain-based security
 */

export class NodeOwnershipManager {
    constructor(qnetIntegration, cryptoManager) {
        this.qnetIntegration = qnetIntegration;
        this.cryptoManager = cryptoManager;
        this.ownershipCache = new Map();
        this.verificationCache = new Map();
    }

    /**
     * Verify node ownership using blockchain verification
     */
    async verifyOwnership(activationCode, walletAddress) {
        try {
            // Check cache first
            const cacheKey = `${activationCode}_${walletAddress}`;
            if (this.verificationCache.has(cacheKey)) {
                const cached = this.verificationCache.get(cacheKey);
                if (Date.now() - cached.timestamp < 300000) { // 5 minutes cache
                    return cached.result;
                }
            }

            // Query QNet blockchain for node ownership
            const nodeRecord = await this.qnetIntegration.makeRPCCall('get_node_owner', {
                activation_code: activationCode
            });

            const isOwner = nodeRecord.owner === walletAddress;
            
            // Cache result
            this.verificationCache.set(cacheKey, {
                result: isOwner,
                timestamp: Date.now(),
                nodeRecord
            });

            return isOwner;

        } catch (error) {
            console.error('Failed to verify node ownership:', error);
            return false;
        }
    }

    /**
     * Transfer node ownership to another wallet
     */
    async transferNode(activationCode, fromWallet, toWallet, privateKey) {
        try {
            // Verify current ownership
            const isOwner = await this.verifyOwnership(activationCode, fromWallet);
            if (!isOwner) {
                throw new Error('Not the owner of this node');
            }

            // Validate destination address
            if (!this.qnetIntegration.validateAddress(toWallet)) {
                throw new Error('Invalid destination address');
            }

            // Check if destination wallet already has a node (one node per wallet rule)
            const destinationNodes = await this.qnetIntegration.getWalletNodes(toWallet);
            if (destinationNodes.length > 0) {
                throw new Error('Destination wallet already has an active node');
            }

            // Create ownership transfer transaction
            const transferTx = await this.qnetIntegration.makeRPCCall('transfer_node_ownership', {
                activation_code: activationCode,
                from: fromWallet,
                to: toWallet,
                private_key: privateKey,
                timestamp: Date.now(),
                signature: await this.createTransferSignature(activationCode, fromWallet, toWallet, privateKey)
            });

            // Clear ownership cache
            this.clearOwnershipCache(activationCode);

            return {
                success: true,
                txHash: transferTx.tx_hash,
                transferredAt: transferTx.transferred_at,
                newOwner: toWallet
            };

        } catch (error) {
            console.error('Failed to transfer node ownership:', error);
            throw error;
        }
    }

    /**
     * Create cryptographic signature for ownership transfer
     */
    async createTransferSignature(activationCode, fromWallet, toWallet, privateKey) {
        try {
            const message = `TRANSFER:${activationCode}:${fromWallet}:${toWallet}:${Date.now()}`;
            const signature = await this.cryptoManager.signMessage(message, privateKey);
            return signature;
        } catch (error) {
            console.error('Failed to create transfer signature:', error);
            throw error;
        }
    }

    /**
     * Get node ownership history
     */
    async getOwnershipHistory(activationCode) {
        try {
            const response = await this.qnetIntegration.makeRPCCall('get_ownership_history', {
                activation_code: activationCode
            });

            return response.history?.map(entry => ({
                owner: entry.owner,
                transferredAt: entry.transferred_at,
                transferTxHash: entry.transfer_tx_hash,
                transferredFrom: entry.transferred_from
            })) || [];

        } catch (error) {
            console.error('Failed to get ownership history:', error);
            return [];
        }
    }

    /**
     * Check if wallet can activate a new node (one node per wallet enforcement)
     */
    async checkNodeLimit(walletAddress) {
        try {
            const activeNodes = await this.qnetIntegration.getWalletNodes(walletAddress);
            
            if (activeNodes.length >= 1) {
                return {
                    canActivate: false,
                    reason: 'Wallet already has an active node',
                    activeNodes: activeNodes.length,
                    maxAllowed: 1
                };
            }

            return {
                canActivate: true,
                activeNodes: activeNodes.length,
                maxAllowed: 1
            };

        } catch (error) {
            console.error('Failed to check node limit:', error);
            return {
                canActivate: false,
                reason: 'Failed to verify current nodes',
                error: error.message
            };
        }
    }

    /**
     * Generate ownership proof for node
     */
    async generateOwnershipProof(activationCode, walletAddress, privateKey) {
        try {
            // Verify ownership first
            const isOwner = await this.verifyOwnership(activationCode, walletAddress);
            if (!isOwner) {
                throw new Error('Not the owner of this node');
            }

            // Get node information
            const nodeInfo = await this.qnetIntegration.getNodeStatus(activationCode);
            
            // Create ownership proof
            const proofData = {
                activationCode,
                owner: walletAddress,
                nodeId: nodeInfo.nodeId,
                nodeType: nodeInfo.nodeType,
                activatedAt: nodeInfo.activatedAt,
                timestamp: Date.now()
            };

            // Sign the proof
            const signature = await this.cryptoManager.signMessage(
                JSON.stringify(proofData), 
                privateKey
            );

            return {
                proof: proofData,
                signature,
                valid: true
            };

        } catch (error) {
            console.error('Failed to generate ownership proof:', error);
            throw error;
        }
    }

    /**
     * Verify ownership proof
     */
    async verifyOwnershipProof(proof, signature, publicKey) {
        try {
            // Verify signature
            const messageValid = await this.cryptoManager.verifyMessage(
                JSON.stringify(proof.proof),
                signature,
                publicKey
            );

            if (!messageValid) {
                return { valid: false, reason: 'Invalid signature' };
            }

            // Verify ownership on blockchain
            const blockchainOwner = await this.verifyOwnership(
                proof.proof.activationCode,
                proof.proof.owner
            );

            if (!blockchainOwner) {
                return { valid: false, reason: 'Ownership not confirmed on blockchain' };
            }

            return { valid: true };

        } catch (error) {
            console.error('Failed to verify ownership proof:', error);
            return { valid: false, reason: error.message };
        }
    }

    /**
     * Get all nodes owned by wallet
     */
    async getOwnedNodes(walletAddress) {
        try {
            const nodes = await this.qnetIntegration.getWalletNodes(walletAddress);
            
            // Enhance with ownership details
            const enhancedNodes = await Promise.all(
                nodes.map(async (node) => {
                    const ownershipHistory = await this.getOwnershipHistory(node.nodeId);
                    return {
                        ...node,
                        ownershipHistory,
                        isOwner: true
                    };
                })
            );

            return enhancedNodes;

        } catch (error) {
            console.error('Failed to get owned nodes:', error);
            return [];
        }
    }

    /**
     * Validate node activation code ownership
     */
    async validateActivationCodeOwnership(activationCode) {
        try {
            const response = await this.qnetIntegration.makeRPCCall('validate_activation_code', {
                activation_code: activationCode
            });

            return {
                valid: response.valid,
                owner: response.owner,
                nodeId: response.node_id,
                nodeType: response.node_type,
                status: response.status,
                canTransfer: response.can_transfer
            };

        } catch (error) {
            console.error('Failed to validate activation code:', error);
            return { valid: false, error: error.message };
        }
    }

    /**
     * Create node ownership record
     */
    async createOwnershipRecord(activationCode, owner, nodeType, activationMethod) {
        try {
            const record = {
                activationCode,
                owner,
                nodeType,
                activationMethod, // 'burn' for Phase 1, 'qnc' for Phase 2
                createdAt: Date.now(),
                transferable: true,
                status: 'active'
            };

            // Store in ownership cache
            this.ownershipCache.set(activationCode, record);

            return record;

        } catch (error) {
            console.error('Failed to create ownership record:', error);
            throw error;
        }
    }

    /**
     * Update ownership record
     */
    async updateOwnershipRecord(activationCode, updates) {
        try {
            const existing = this.ownershipCache.get(activationCode);
            if (!existing) {
                throw new Error('Ownership record not found');
            }

            const updated = {
                ...existing,
                ...updates,
                updatedAt: Date.now()
            };

            this.ownershipCache.set(activationCode, updated);
            return updated;

        } catch (error) {
            console.error('Failed to update ownership record:', error);
            throw error;
        }
    }

    /**
     * Clear ownership cache for specific node
     */
    clearOwnershipCache(activationCode) {
        this.ownershipCache.delete(activationCode);
        
        // Clear verification cache entries
        for (const [key, value] of this.verificationCache.entries()) {
            if (key.startsWith(activationCode)) {
                this.verificationCache.delete(key);
            }
        }
    }

    /**
     * Clear all ownership caches
     */
    clearAllCaches() {
        this.ownershipCache.clear();
        this.verificationCache.clear();
    }

    /**
     * Get ownership statistics
     */
    getOwnershipStats() {
        return {
            cachedRecords: this.ownershipCache.size,
            verificationCacheSize: this.verificationCache.size,
            cacheHitRate: this.calculateCacheHitRate()
        };
    }

    /**
     * Calculate cache hit rate
     */
    calculateCacheHitRate() {
        // This would be implemented with proper metrics tracking
        return 0.85; // Example 85% hit rate
    }

    /**
     * Export ownership data for backup
     */
    exportOwnershipData() {
        const data = {
            timestamp: Date.now(),
            records: Array.from(this.ownershipCache.entries()),
            verifications: Array.from(this.verificationCache.entries())
        };

        return JSON.stringify(data);
    }

    /**
     * Import ownership data from backup
     */
    importOwnershipData(jsonData) {
        try {
            const data = JSON.parse(jsonData);
            
            // Restore ownership cache
            this.ownershipCache.clear();
            for (const [key, value] of data.records) {
                this.ownershipCache.set(key, value);
            }

            // Restore verification cache (only recent entries)
            this.verificationCache.clear();
            const fiveMinutesAgo = Date.now() - 300000;
            for (const [key, value] of data.verifications) {
                if (value.timestamp > fiveMinutesAgo) {
                    this.verificationCache.set(key, value);
                }
            }

            return true;

        } catch (error) {
            console.error('Failed to import ownership data:', error);
            return false;
        }
    }
} 