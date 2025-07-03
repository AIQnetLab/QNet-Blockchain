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
     * Calculate Phase 1 activation cost (1DEV burn)
     */
    calculatePhase1Cost() {
        const burnedPercent = this.mockData.totalBurnedPercent;
        const reductionFactor = Math.min(burnedPercent / 10, 9); // Max 90% reduction
        const reduction = reductionFactor * this.PRICE_REDUCTION_PER_10_PERCENT;
        const currentPrice = Math.max(
            this.PHASE_1_BASE_PRICE - reduction,
            this.PHASE_1_BASE_PRICE * 0.1 // Minimum 10% of base price (150 1DEV)
        );
        
        return {
            cost: Math.round(currentPrice),
            token: '1DEV',
            mechanism: 'burn',
            description: `Burn ${Math.round(currentPrice)} 1DEV tokens (${burnedPercent}% supply burned)`
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
        const baseCost = this.PHASE_2_BASE_COSTS[nodeType];
        const multiplier = this.getNetworkMultiplier(this.mockData.activeNodes);
        const finalCost = Math.round(baseCost * multiplier);
        
        // Calculate range for display
        const minCost = Math.round(baseCost * 0.5);  // Minimum at 0.5x
        const maxCost = Math.round(baseCost * 3.0);  // Maximum at 3.0x
        
        return {
            cost: finalCost,
            token: 'QNC',
            mechanism: 'spend-to-pool3',
            description: `Spend ${finalCost} QNC to Pool 3 (${this.mockData.activeNodes.toLocaleString()} active nodes)`,
            range: `${minCost.toLocaleString()}-${maxCost.toLocaleString()} QNC`,
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
                title: 'Phase 1: 1DEV Burn-to-Join',
                subtitle: `${this.mockData.totalBurnedPercent}% of supply burned`,
                cost: cost.cost,
                token: cost.token,
                mechanism: 'Burn tokens permanently',
                details: [
                    `All node types: ${cost.cost} 1DEV`,
                    `Price decreases as more tokens burned`,
                    `Minimum cost: 150 1DEV (at 90% burned)`
                ]
            };
        } else {
            return {
                phase: 2,
                title: 'Phase 2: QNC Spend-to-Pool3',
                subtitle: `${this.mockData.activeNodes.toLocaleString()} active nodes`,
                mechanism: 'Spend QNC to Pool 3 (redistributed to all nodes)',
                details: [
                    `Light Node: ${this.calculatePhase2Cost('light').range}`,
                    `Full Node: ${this.calculatePhase2Cost('full').range}`,
                    `Super Node: ${this.calculatePhase2Cost('super').range}`,
                    `Current multiplier: ${this.getNetworkMultiplier(this.mockData.activeNodes)}x`
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

// ES6 module export
export { DynamicPricing };
