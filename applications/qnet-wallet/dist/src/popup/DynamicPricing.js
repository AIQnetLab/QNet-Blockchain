/**
 * QNet Dynamic Pricing System
 * Production implementation for wallet extension
 * 
 * DISCLAIMER: QNet is experimental research technology. 
 * No guarantees of network operation, token values, or rewards.
 * Participate only with funds you can afford to lose completely.
 */

class DynamicPricing {
    constructor() {
        // Phase 1: 1DEV burn-to-join constants
        this.PHASE_1_BASE_PRICE = 1500; // 1DEV
        this.PRICE_REDUCTION_PER_10_PERCENT = 150; // 1DEV
        this.BURN_TARGET_PERCENT = 90;
        this.TIME_LIMIT_YEARS = 5;
        
        // Phase 2: QNC spending to Pool 3 constants
        this.PHASE_2_BASE_COSTS = {
            light: 5000,  // QNC to spend to Pool 3
            full: 7500,   // QNC to spend to Pool 3
            super: 10000  // QNC to spend to Pool 3
        };
        
        // Network size multipliers for Phase 2
        this.NETWORK_SIZE_MULTIPLIERS = [
            { min: 0, max: 100000, multiplier: 0.5 },        // 0-100K nodes: early discount
            { min: 100001, max: 300000, multiplier: 1.0 },   // 100K-300K nodes: standard rate
            { min: 300001, max: 1000000, multiplier: 2.0 },  // 300K-1M nodes: high demand
            { min: 1000001, max: Infinity, multiplier: 3.0 } // 1M+ nodes: mature network
        ];
        
        // Mock data for testing
        this.mockData = {
            totalBurnedPercent: 15, // 15% of 1DEV supply burned
            activeNodes: 156,       // Current active nodes in network
            currentPhase: 'phase1'  // Current phase
        };
    }
    
    /**
     * Calculate Phase 1 activation cost - Dynamic pricing
     */
    calculatePhase1Cost() {
        // Calculate reduction based on burn percentage
        const burnPercent = this.mockData.totalBurnedPercent;
        const reductionTiers = Math.floor(burnPercent / 10);
        const totalReduction = reductionTiers * this.PRICE_REDUCTION_PER_10_PERCENT;
        const currentPrice = Math.max(this.PHASE_1_BASE_PRICE - totalReduction, 300); // Min price: 300 1DEV
        
        return {
            cost: currentPrice,
            token: '1DEV',
            mechanism: 'burn',
            description: `Burn ${currentPrice} 1DEV for activation (${burnPercent}% already burned)`,
            burnPercent: burnPercent,
            savings: this.PHASE_1_BASE_PRICE - currentPrice,
            baseCost: this.PHASE_1_BASE_PRICE
        };
    }
    
    /**
     * Get network size multiplier for Phase 2
     */
    getNetworkMultiplier(activeNodes) {
        for (const tier of this.NETWORK_SIZE_MULTIPLIERS) {
            if (activeNodes >= tier.min && activeNodes <= tier.max) {
                return tier.multiplier;
            }
        }
        return 1.0; // Default fallback
    }
    
    /**
     * Calculate Phase 2 activation cost (QNC spending to Pool 3)
     */
    calculatePhase2Cost(nodeType) {
        const baseCost = this.PHASE_2_BASE_COSTS[nodeType] || this.PHASE_2_BASE_COSTS.full;
        const multiplier = this.getNetworkMultiplier(this.mockData.activeNodes);
        const finalCost = Math.round(baseCost * multiplier);
        
        return {
            cost: finalCost,
            token: 'QNC',
            mechanism: 'transfer', // Transfer to Pool 3, not burn
            description: `Transfer ${finalCost} QNC to Pool #3 for activation`,
            baseCost: baseCost,
            multiplier: multiplier,
            networkSize: this.mockData.activeNodes
        };
    }
    
    /**
     * Get activation cost for any node type
     */
    getActivationCost(nodeType = 'light') {
        if (this.mockData.currentPhase === 'phase1') {
            return this.calculatePhase1Cost();
        } else {
            return this.calculatePhase2Cost(nodeType);
        }
    }
    
    /**
     * Get detailed pricing information for UI display
     */
    getPricingInfo() {
        if (this.mockData.currentPhase === 'phase1') {
            const cost = this.calculatePhase1Cost();
            return {
                phase: 1,
                title: `Phase 1: 1DEV Burn Activation`,
                subtitle: `${cost.burnPercent}% of supply burned`,
                cost: cost.cost,
                token: '1DEV',
                mechanism: 'Token burn on Solana',
                details: [
                    `Current price: ${cost.cost} 1DEV (all node types)`,
                    `Original price: ${cost.baseCost} 1DEV`,
                    `Your savings: ${cost.savings} 1DEV`,
                    `Minimum price: 300 1DEV at 80-90% burned`
                ]
            };
        } else {
            const lightCost = this.calculatePhase2Cost('light');
            const fullCost = this.calculatePhase2Cost('full');
            const superCost = this.calculatePhase2Cost('super');
            
            return {
                phase: 2,
                title: 'Phase 2: QNC Transfer Activation',
                subtitle: `Transfer to Pool #3 for redistribution`,
                mechanism: 'QNC transfer to Pool #3',
                details: [
                    `Light Node: ${lightCost.cost} QNC`,
                    `Full Node: ${fullCost.cost} QNC`, 
                    `Super Node: ${superCost.cost} QNC`,
                    `Network multiplier: ${lightCost.multiplier}x (${lightCost.networkSize} nodes)`
                ]
            };
        }
    }
    
    /**
     * Check if phase transition should occur
     */
    shouldTransitionToPhase2() {
        const burnedPercent = this.mockData.totalBurnedPercent;
        const timePassed = 0; // Mock: years since launch
        
        return burnedPercent >= this.BURN_TARGET_PERCENT || timePassed >= this.TIME_LIMIT_YEARS;
    }
    
    /**
     * Update mock data (for testing)
     */
    updateMockData(data) {
        this.mockData = { ...this.mockData, ...data };
    }
    
    /**
     * Get current phase information
     */
    getCurrentPhase() {
        return {
            phase: this.mockData.currentPhase,
            burnedPercent: this.mockData.totalBurnedPercent,
            activeNodes: this.mockData.activeNodes,
            shouldTransition: this.shouldTransitionToPhase2()
        };
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = DynamicPricing;
} else {
    window.DynamicPricing = DynamicPricing;
}
