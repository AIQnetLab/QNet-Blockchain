/**
 * Rewards UI for QNet wallet
 * Displays three-pool rewards breakdown and lazy claim functionality
 */

import { NodeManager } from '../node/NodeManager.js';
import { NetworkManager } from '../network/NetworkManager.js';

export class RewardsUI {
    constructor(walletManager) {
        this.walletManager = walletManager;
        this.nodeManager = new NodeManager();
        this.networkManager = new NetworkManager();
        this.currentRewards = null;
        this.refreshInterval = null;
        this.isClaimingRewards = false;
    }

    /**
     * Initialize rewards UI
     */
    async initialize() {
        try {
            await this.nodeManager.initialize();
            this.startRewardsRefresh();
        } catch (error) {
            console.error('Failed to initialize RewardsUI:', error);
        }
    }

    /**
     * Show rewards interface
     */
    showRewardsInterface() {
        const container = this.getMainContainer();
        
        container.innerHTML = `
            <div class="rewards-interface">
                <div class="rewards-header">
                    <h2>💰 QNet Rewards</h2>
                    <div class="phase-indicator">
                        <span class="phase-badge" id="current-phase">Phase 1</span>
                        <span class="refresh-time" id="last-refresh">Updated: Never</span>
                    </div>
                </div>

                <div class="rewards-summary">
                    <div class="summary-card unclaimed">
                        <h3>Available to Claim</h3>
                        <div class="amount-display">
                            <span class="amount" id="unclaimed-amount">0.000</span>
                            <span class="currency">QNC</span>
                        </div>
                        <div class="claim-status" id="claim-status">
                            <span class="status-text">Minimum 1.0 QNC required</span>
                        </div>
                    </div>

                    <div class="summary-card total">
                        <h3>Total Earned</h3>
                        <div class="amount-display">
                            <span class="amount" id="total-earned">0.000</span>
                            <span class="currency">QNC</span>
                        </div>
                        <div class="claim-info">
                            <span id="last-claim">Last claim: Never</span>
                        </div>
                    </div>
                </div>

                <div class="pool-breakdown">
                    <h3>📊 Three-Pool Breakdown</h3>
                    
                    <div class="pool-card pool1">
                        <div class="pool-header">
                            <h4>Pool 1: Base Emission</h4>
                            <span class="pool-amount" id="pool1-amount">0.000 QNC</span>
                        </div>
                        <div class="pool-description">
                            <p>Dynamic emission with halvings every 4 years</p>
                            <p>Distributed equally to all active nodes every 4 hours</p>
                        </div>
                        <div class="pool-stats">
                            <span class="stat-label">Your share:</span>
                            <span class="stat-value" id="pool1-share">0.000 QNC</span>
                        </div>
                    </div>

                    <div class="pool-card pool2">
                        <div class="pool-header">
                            <h4>Pool 2: Transaction Fees</h4>
                            <span class="pool-amount" id="pool2-amount">0.000 QNC</span>
                        </div>
                        <div class="pool-description">
                            <p>70% Super nodes, 30% Full nodes, 0% Light nodes</p>
                            <p>Fees from all network transactions</p>
                        </div>
                        <div class="pool-stats">
                            <span class="stat-label">Your share:</span>
                            <span class="stat-value" id="pool2-share">0.000 QNC</span>
                        </div>
                    </div>

                    <div class="pool-card pool3">
                        <div class="pool-header">
                            <h4>Pool 3: Activation Pool</h4>
                            <span class="pool-amount" id="pool3-amount">0.000 QNC</span>
                        </div>
                        <div class="pool-description">
                            <p>QNC spent on node activation in Phase 2</p>
                            <p>Distributed equally to all active nodes</p>
                        </div>
                        <div class="pool-stats">
                            <span class="stat-label">Your share:</span>
                            <span class="stat-value" id="pool3-share">0.000 QNC</span>
                        </div>
                        <div class="pool-status" id="pool3-status">
                            <span class="status-disabled">Disabled in Phase 1</span>
                        </div>
                    </div>
                </div>

                <div class="ping-requirements">
                    <h3>📡 Ping Requirements</h3>
                    <div class="ping-status" id="ping-status">
                        <div class="ping-info">
                            <span class="ping-label">Success Rate:</span>
                            <span class="ping-value" id="ping-success-rate">0%</span>
                        </div>
                        <div class="ping-info">
                            <span class="ping-label">Required:</span>
                            <span class="ping-value" id="ping-required">100%</span>
                        </div>
                        <div class="ping-info">
                            <span class="ping-label">Status:</span>
                            <span class="ping-value" id="ping-meets-requirements">❌ Not eligible</span>
                        </div>
                    </div>
                </div>

                <div class="claim-section">
                    <button 
                        class="claim-button" 
                        id="claim-rewards-button"
                        onclick="rewardsUI.claimRewards()"
                        disabled
                    >
                        💰 Claim Rewards
                    </button>
                    <div class="claim-info">
                        <p>• Minimum claim: 1.0 QNC</p>
                        <p>• Rate limit: Once per hour</p>
                        <p>• Must meet ping requirements</p>
                    </div>
                </div>

                <div class="rewards-history">
                    <h3>📈 Recent Claims</h3>
                    <div id="rewards-history-list">
                        <p class="no-data">No claims yet</p>
                    </div>
                </div>
            </div>
        `;

        // Load initial data
        this.loadRewardsData();
    }

    /**
     * Load rewards data from network
     */
    async loadRewardsData() {
        try {
            const rewardStats = await this.nodeManager.getRewardStats();
            this.currentRewards = rewardStats;
            
            // Update UI
            this.updateRewardsDisplay(rewardStats);
            
            // Update refresh time
            document.getElementById('last-refresh').textContent = 
                `Updated: ${new Date().toLocaleTimeString()}`;
                
        } catch (error) {
            console.error('Failed to load rewards data:', error);
            this.showError('Failed to load rewards data');
        }
    }

    /**
     * Update rewards display
     */
    updateRewardsDisplay(rewards) {
        // Update phase indicator
        const phaseElement = document.getElementById('current-phase');
        if (phaseElement) {
            phaseElement.textContent = `Phase ${rewards.phase}`;
            phaseElement.className = `phase-badge phase${rewards.phase}`;
        }

        // Update summary cards
        this.updateElement('unclaimed-amount', rewards.unclaimed.toFixed(3));
        this.updateElement('total-earned', rewards.totalEarned.toFixed(3));
        this.updateElement('last-claim', `Last claim: ${this.formatDate(rewards.lastClaim)}`);

        // Update pool breakdown
        this.updateElement('pool1-amount', rewards.poolBreakdown.pool1_base.toFixed(3));
        this.updateElement('pool2-amount', rewards.poolBreakdown.pool2_fees.toFixed(3));
        this.updateElement('pool3-amount', rewards.poolBreakdown.pool3_activation.toFixed(3));

        // Update individual shares
        this.updateElement('pool1-share', rewards.poolBreakdown.pool1_base.toFixed(3));
        this.updateElement('pool2-share', rewards.poolBreakdown.pool2_fees.toFixed(3));
        this.updateElement('pool3-share', rewards.poolBreakdown.pool3_activation.toFixed(3));

        // Update ping status
        this.updateElement('ping-success-rate', `${(rewards.pingSuccessRate * 100).toFixed(1)}%`);
        this.updateElement('ping-required', this.getPingRequirement(rewards.nodeType));
        this.updateElement('ping-meets-requirements', 
            rewards.meetsRequirements ? '✅ Eligible' : '❌ Not eligible'
        );

        // Update Pool 3 status
        const pool3Status = document.getElementById('pool3-status');
        if (pool3Status) {
            if (rewards.phase === 2) {
                pool3Status.innerHTML = '<span class="status-enabled">Active in Phase 2</span>';
                pool3Status.className = 'pool-status enabled';
            } else {
                pool3Status.innerHTML = '<span class="status-disabled">Disabled in Phase 1</span>';
                pool3Status.className = 'pool-status disabled';
            }
        }

        // Update claim button
        this.updateClaimButton(rewards);
        
        // Update claim status
        this.updateClaimStatus(rewards);
    }

    /**
     * Update claim button state
     */
    updateClaimButton(rewards) {
        const button = document.getElementById('claim-rewards-button');
        if (!button) return;

        const canClaim = rewards.canClaim && rewards.meetsRequirements && !this.isClaimingRewards;
        
        button.disabled = !canClaim;
        button.className = canClaim ? 'claim-button enabled' : 'claim-button disabled';
        
        if (this.isClaimingRewards) {
            button.textContent = '⏳ Claiming...';
        } else if (canClaim) {
            button.textContent = `💰 Claim ${rewards.unclaimed.toFixed(3)} QNC`;
        } else {
            button.textContent = '💰 Claim Rewards';
        }
    }

    /**
     * Update claim status message
     */
    updateClaimStatus(rewards) {
        const statusElement = document.getElementById('claim-status');
        if (!statusElement) return;

        let statusText = '';
        let statusClass = '';

        if (!rewards.meetsRequirements) {
            statusText = 'Ping requirements not met';
            statusClass = 'status-error';
        } else if (rewards.unclaimed < 1.0) {
            statusText = `Need ${(1.0 - rewards.unclaimed).toFixed(3)} more QNC to claim`;
            statusClass = 'status-warning';
        } else if (rewards.canClaim) {
            statusText = 'Ready to claim!';
            statusClass = 'status-success';
        } else {
            statusText = 'Checking eligibility...';
            statusClass = 'status-info';
        }

        statusElement.innerHTML = `<span class="status-text ${statusClass}">${statusText}</span>`;
    }

    /**
     * Claim rewards
     */
    async claimRewards() {
        if (this.isClaimingRewards) return;
        
        this.isClaimingRewards = true;
        
        try {
            // Show loading state
            this.updateClaimButton(this.currentRewards);
            
            // Submit claim
            const result = await this.nodeManager.claimRewards();
            
            // Show success message
            this.showSuccess(
                `Successfully claimed ${result.amount.toFixed(3)} QNC!`,
                `Transaction: ${result.tx_hash}`
            );
            
            // Refresh rewards data
            await this.loadRewardsData();
            
        } catch (error) {
            console.error('Failed to claim rewards:', error);
            this.showError(error.message || 'Failed to claim rewards');
        } finally {
            this.isClaimingRewards = false;
            this.updateClaimButton(this.currentRewards);
        }
    }

    /**
     * Get ping requirement for node type
     */
    getPingRequirement(nodeType) {
        switch (nodeType) {
            case 'light': return '100% (1 ping per 4h)';
            case 'full': return '95% (57/60 pings per 4h)';
            case 'super': return '98% (59/60 pings per 4h)';
            default: return '100%';
        }
    }

    /**
     * Format date for display
     */
    formatDate(timestamp) {
        if (!timestamp || timestamp === 'Never') return 'Never';
        
        const date = new Date(timestamp);
        return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
    }

    /**
     * Start automatic rewards refresh
     */
    startRewardsRefresh() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
        }
        
        // Refresh every 30 seconds
        this.refreshInterval = setInterval(() => {
            this.loadRewardsData();
        }, 30000);
    }

    /**
     * Stop automatic refresh
     */
    stopRewardsRefresh() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
    }

    /**
     * Utility methods
     */
    getMainContainer() {
        return document.getElementById('main-content') || document.body;
    }

    updateElement(id, text) {
        const element = document.getElementById(id);
        if (element) {
            element.textContent = text;
        }
    }

    showSuccess(message, details = '') {
        // Implementation depends on your notification system
        console.log('SUCCESS:', message, details);
        alert(`${message}\n${details}`);
    }

    showError(message) {
        // Implementation depends on your notification system
        console.error('ERROR:', message);
        alert(`Error: ${message}`);
    }

    /**
     * Cleanup
     */
    destroy() {
        this.stopRewardsRefresh();
        if (this.nodeManager) {
            this.nodeManager.destroy();
        }
    }
}

// Export for global use
window.rewardsUI = new RewardsUI(); 