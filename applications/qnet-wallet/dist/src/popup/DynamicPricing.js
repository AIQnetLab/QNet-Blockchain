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
            { min: 100001, max: 1000000, multiplier: 1.0 },  // 100K-1M nodes: standard rate
            { min: 1000001, max: 10000000, multiplier: 2.0 }, // 1M-10M nodes: high demand
            { min: 10000001, max: Infinity, multiplier: 3.0 } // 10M+ nodes: mature network
        ];
        
        // Mock data for testing
        this.mockData = {
            totalBurnedPercent: 15, // 15% of 1DEV supply burned
            activeNodes: 156,       // Current active nodes in network
            currentPhase: 'phase1'  // Current phase
        };
    }
    
    /**
     * Calculate Phase 1 activation cost - FREE
     */
    calculatePhase1Cost() {
        // FREE wallet - no cost
        const currentPrice = 0;
        
        return {
            cost: 0, // FREE
            token: 'FREE',
            mechanism: 'free',
            description: 'FREE activation - no tokens required!'
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
        // FREE wallet - no cost
        return {
            cost: 0, // FREE
            token: 'FREE',
            mechanism: 'free',
            description: 'FREE activation - no tokens required!',
            range: 'FREE',
            multiplier: 0,
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
                title: 'FREE Activation',
                subtitle: 'No fees or costs!',
                cost: 0,
                token: 'FREE',
                mechanism: 'Instant free activation',
                details: [
                    'All node types: FREE',
                    'No tokens required',
                    'Instant activation'
                ]
            };
        } else {
            return {
                phase: 2,
                title: 'FREE Activation',
                subtitle: 'No fees or costs!',
                mechanism: 'Instant free activation',
                details: [
                    'Light Node: FREE',
                    'Full Node: FREE', 
                    'Super Node: FREE',
                    'All nodes activate instantly for free'
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
