// QNet Node Manager - Simplified

import { StorageManager } from '../storage/StorageManager.js';
import { NetworkManager } from '../network/NetworkManager.js';

export class NodeManager {
    constructor() {
        this.storage = new StorageManager();
        this.network = new NetworkManager();
        this.nodeConfig = null;
    }
    
    // Initialize node manager
    async initialize() {
        this.nodeConfig = await this.storage.getNodeConfig();
    }
    
    // Activate node (one-time burn)
    async activateNode(nodeType, ownerAddress, burnTxHash) {
        try {
            // Check if node already exists
            if (this.nodeConfig && this.nodeConfig.nodeId) {
                throw new Error('Node already activated');
            }
            
            // Register node with network using burn proof
            const nodeId = await this.network.activateNode(
                nodeType,
                ownerAddress,
                burnTxHash
            );
            
            // Create node configuration
            const config = {
                nodeId,
                nodeType,
                ownerAddress,
                burnTxHash,
                activatedAt: Date.now(),
                claimedRewards: 0
            };
            
            // Save configuration
            await this.storage.saveNodeConfig(config);
            this.nodeConfig = config;
            
            return nodeId;
        } catch (error) {
            console.error('Error activating node:', error);
            throw error;
        }
    }
    
    // Get node status
    async getNodeStatus() {
        if (!this.nodeConfig || !this.nodeConfig.nodeId) {
            return {
                exists: false,
                active: false
            };
        }
        
        try {
            // Get current data from network
            const networkData = await this.network.getNodeInfo(this.nodeConfig.nodeId);
            
            return {
                exists: true,
                active: networkData?.active || false,
                nodeId: this.nodeConfig.nodeId,
                type: this.nodeConfig.nodeType,
                pendingRewards: networkData?.pendingRewards || 0,
                claimedRewards: this.nodeConfig.claimedRewards,
                totalRewards: (networkData?.pendingRewards || 0) + this.nodeConfig.claimedRewards,
                activatedAt: this.nodeConfig.activatedAt,
                uptime: networkData?.uptime || 0,
                reputation: networkData?.reputation || 0
            };
        } catch (error) {
            console.error('Error getting node status:', error);
            return {
                exists: true,
                active: false,
                error: error.message
            };
        }
    }
    
    // Claim rewards (lazy claim system)
    async claimRewards() {
        if (!this.nodeConfig || !this.nodeConfig.nodeId) {
            throw new Error('No node activated');
        }
        
        try {
            // Check last claim time (rate limit: once per hour)
            const now = Date.now();
            const lastClaim = this.nodeConfig.lastClaim || 0;
            const timeSinceLastClaim = now - lastClaim;
            
            if (timeSinceLastClaim < 60 * 60 * 1000) { // 1 hour
                const minutesLeft = Math.ceil((60 * 60 * 1000 - timeSinceLastClaim) / 60000);
                throw new Error(`Please wait ${minutesLeft} minutes before next claim`);
            }
            
            // Get current rewards from network
            const networkData = await this.network.getNodeInfo(this.nodeConfig.nodeId);
            const pendingRewards = networkData?.pendingRewards || 0;
            
            if (pendingRewards <= 0) {
                throw new Error('No rewards to claim');
            }
            
            // Claim rewards from network
            const claimedAmount = await this.network.claimNodeRewards(
                this.nodeConfig.nodeId,
                this.nodeConfig.ownerAddress
            );
            
            // Update configuration
            this.nodeConfig.claimedRewards += claimedAmount;
            this.nodeConfig.lastClaim = now;
            
            // Save configuration
            await this.storage.saveNodeConfig(this.nodeConfig);
            
            return {
                amount: claimedAmount,
                totalClaimed: this.nodeConfig.claimedRewards
            };
        } catch (error) {
            console.error('Error claiming rewards:', error);
            throw error;
        }
    }
} 