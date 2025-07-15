// QNet Node Manager - Simplified

import { NetworkManager } from '../network/NetworkManager.js';
import { StorageManager } from '../storage/StorageManager.js';
import { SecurityManager } from '../security/SecurityManager.js';

export class NodeManager {
    constructor() {
        this.network = new NetworkManager();
        this.storage = new StorageManager();
        this.security = new SecurityManager();
        this.nodeConfig = null;
        this.rewardHistory = [];
        this.pingHistory = [];
        
        // Phase-aware reward system integration
        this.currentPhase = 1; // Will be updated from network
        this.lastPhaseCheck = 0;
        this.phaseCheckInterval = 60000; // Check phase every minute
        
        // Ping success tracking for rewards
        this.pingSuccessRate = {
            light: 1.0,   // 100% success rate required
            full: 0.95,   // 95% success rate required  
            super: 0.98   // 98% success rate required
        };
    }
    
    async initialize() {
        try {
            // Load node configuration
            this.nodeConfig = await this.storage.getNodeConfig();
            
            // Start periodic phase checking
            this.startPhaseMonitoring();
            
            return true;
        } catch (error) {
            console.error('Failed to initialize NodeManager:', error);
            return false;
        }
    }
    
    // Start monitoring network phase changes
    startPhaseMonitoring() {
        this.phaseCheckInterval = setInterval(async () => {
            try {
                const networkPhase = await this.network.getCurrentPhase();
                if (networkPhase !== this.currentPhase) {
                    console.log(`Phase transition detected: ${this.currentPhase} → ${networkPhase}`);
                    this.currentPhase = networkPhase;
                    
                    // Update UI if needed
                    if (typeof window !== 'undefined' && window.postMessage) {
                        window.postMessage({
                            type: 'PHASE_CHANGED',
                            phase: networkPhase
                        }, '*');
                    }
                }
            } catch (error) {
                console.error('Error checking network phase:', error);
            }
        }, this.phaseCheckInterval);
    }
    
    // Check current rewards status
    async checkRewards() {
        if (!this.nodeConfig || !this.nodeConfig.nodeId) {
            throw new Error('No node activated');
        }
        
        try {
            const rewardData = await this.network.getNodeRewards(this.nodeConfig.nodeId);
            
            return {
                unclaimed: rewardData.unclaimed || 0,
                pool1_base: rewardData.pool1_base || 0,
                pool2_fees: rewardData.pool2_fees || 0,
                pool3_activation: rewardData.pool3_activation || 0,
                total_earned: rewardData.total_earned || 0,
                last_claim: rewardData.last_claim || 'Never',
                current_phase: rewardData.current_phase || this.currentPhase,
                ping_success_rate: rewardData.ping_success_rate || 0,
                meets_ping_requirements: rewardData.meets_ping_requirements || false
            };
        } catch (error) {
            console.error('Error checking rewards:', error);
            throw error;
        }
    }
    
    // Claim accumulated rewards (MANUAL - lazy claim system)
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
            
            // Get current rewards breakdown
            const rewardData = await this.checkRewards();
            
            if (rewardData.unclaimed <= 0) {
                throw new Error('No rewards to claim');
            }
            
            // Minimum claim amount to reduce network load
            if (rewardData.unclaimed < 1.0) {
                throw new Error(`Minimum claim amount is 1.0 QNC. Current: ${rewardData.unclaimed.toFixed(3)} QNC`);
            }
            
            // Submit claim request to network
            const claimResult = await this.network.claimNodeRewards(
                this.nodeConfig.nodeId,
                this.nodeConfig.ownerAddress,
                rewardData.unclaimed
            );
            
            // Update local configuration
            this.nodeConfig.claimedRewards = (this.nodeConfig.claimedRewards || 0) + claimResult.amount;
            this.nodeConfig.lastClaim = now;
            
            // Add to reward history
            this.rewardHistory.push({
                timestamp: now,
                amount: claimResult.amount,
                pool1_base: rewardData.pool1_base,
                pool2_fees: rewardData.pool2_fees,
                pool3_activation: rewardData.pool3_activation,
                phase: this.currentPhase,
                tx_hash: claimResult.tx_hash
            });
            
            // Save configuration
            await this.storage.saveNodeConfig(this.nodeConfig);
            
            return {
                success: true,
                amount: claimResult.amount,
                breakdown: {
                    pool1_base: rewardData.pool1_base,
                    pool2_fees: rewardData.pool2_fees,
                    pool3_activation: rewardData.pool3_activation
                },
                totalClaimed: this.nodeConfig.claimedRewards,
                tx_hash: claimResult.tx_hash
            };
        } catch (error) {
            console.error('Error claiming rewards:', error);
            throw error;
        }
    }
    
    // Report ping result for reward eligibility
    async reportPingResult(success, responseTime) {
        if (!this.nodeConfig || !this.nodeConfig.nodeId) {
            return;
        }
        
        try {
            // Submit ping result to network
            await this.network.reportPingResult(
                this.nodeConfig.nodeId,
                success,
                responseTime
            );
            
            // Update local ping history
            this.pingHistory.push({
                timestamp: Date.now(),
                success: success,
                responseTime: responseTime
            });
            
            // Keep only last 100 pings
            if (this.pingHistory.length > 100) {
                this.pingHistory = this.pingHistory.slice(-100);
            }
            
            // Calculate success rate
            const recentPings = this.pingHistory.slice(-60); // Last 60 pings (4 hours)
            const successfulPings = recentPings.filter(p => p.success).length;
            const currentSuccessRate = successfulPings / recentPings.length;
            
            // Check if meets requirements
            const nodeType = this.nodeConfig.nodeType || 'light';
            const requiredRate = this.pingSuccessRate[nodeType];
            const meetsRequirements = currentSuccessRate >= requiredRate;
            
            console.log(`Ping success rate: ${(currentSuccessRate * 100).toFixed(1)}% (required: ${(requiredRate * 100).toFixed(1)}%)`);
            
            return {
                success: success,
                currentSuccessRate: currentSuccessRate,
                meetsRequirements: meetsRequirements
            };
        } catch (error) {
            console.error('Error reporting ping result:', error);
            throw error;
        }
    }
    
    // Get reward statistics
    async getRewardStats() {
        try {
            const rewards = await this.checkRewards();
            const stats = {
                unclaimed: rewards.unclaimed,
                totalEarned: rewards.total_earned,
                claimedToday: 0,
                avgDailyRewards: 0,
                poolBreakdown: {
                    pool1_base: rewards.pool1_base,
                    pool2_fees: rewards.pool2_fees,
                    pool3_activation: rewards.pool3_activation
                },
                phase: this.currentPhase,
                pingSuccessRate: rewards.ping_success_rate,
                meetsRequirements: rewards.meets_ping_requirements,
                canClaim: rewards.unclaimed >= 1.0 // Minimum claim amount
            };
            
            // Calculate daily stats from history
            const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
            const todaysClaims = this.rewardHistory.filter(r => r.timestamp > oneDayAgo);
            stats.claimedToday = todaysClaims.reduce((sum, r) => sum + r.amount, 0);
            
            if (this.rewardHistory.length > 0) {
                const totalDays = Math.max(1, (Date.now() - this.rewardHistory[0].timestamp) / (24 * 60 * 60 * 1000));
                stats.avgDailyRewards = stats.totalEarned / totalDays;
            }
            
            return stats;
        } catch (error) {
            console.error('Error getting reward stats:', error);
            throw error;
        }
    }
    
    // Get node status
    async getNodeStatus() {
        if (!this.nodeConfig) {
            return { status: 'inactive', message: 'No node activated' };
        }
        
        try {
            const networkStatus = await this.network.getNodeStatus(this.nodeConfig.nodeId);
            const rewards = await this.checkRewards();
            
            return {
                status: networkStatus.status,
                nodeId: this.nodeConfig.nodeId,
                nodeType: this.nodeConfig.nodeType,
                activatedAt: this.nodeConfig.activatedAt,
                phase: this.currentPhase,
                rewards: {
                    unclaimed: rewards.unclaimed,
                    total: rewards.total_earned,
                    canClaim: rewards.unclaimed >= 1.0,
                    meetsRequirements: rewards.meets_ping_requirements
                },
                network: {
                    connected: networkStatus.connected,
                    peers: networkStatus.peers,
                    lastPing: networkStatus.lastPing
                }
            };
        } catch (error) {
            console.error('Error getting node status:', error);
            return { 
                status: 'error', 
                message: error.message,
                phase: this.currentPhase 
            };
        }
    }
    
    // Cleanup
    destroy() {
        if (this.phaseCheckInterval) {
            clearInterval(this.phaseCheckInterval);
        }
    }
} 