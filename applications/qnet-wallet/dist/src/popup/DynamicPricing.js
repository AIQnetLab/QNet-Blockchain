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
        // CANONICAL VALUES - same across all components
        this.NETWORK_SIZE_MULTIPLIERS = [
            { min: 0, max: 100000, multiplier: 0.5 },         // ≤100K: Early adopter discount
            { min: 100001, max: 300000, multiplier: 1.0 },    // ≤300K: Base price
            { min: 300001, max: 1000000, multiplier: 2.0 },   // ≤1M: High demand
            { min: 1000001, max: Infinity, multiplier: 3.0 }  // >1M: Maximum (cap)
        ];
        
        // Live data from blockchain (updated via updateLiveData())
        // NO DEFAULTS - must call updateLiveData() before using
        this.liveData = {
            totalBurnedPercent: null,  // Updated from Solana blockchain
            activeNodes: null,         // Updated from QNet bootstrap nodes  
            currentPhase: null,        // Calculated from burn% and time
            lastUpdate: null           // Timestamp of last successful update
        };
        
        // Flag to track if data is available
        this.dataAvailable = false;
        
        // PRODUCTION: Real Genesis node IPs (from genesis_constants.rs)
        this.bootstrapNodes = [
            'http://154.38.160.39:8080',   // Genesis #1 - North America
            'http://62.171.157.44:8080',   // Genesis #2 - Europe
            'http://161.97.86.81:8080',    // Genesis #3 - Europe
            'http://5.189.130.160:8080',   // Genesis #4 - Europe
            'http://162.244.25.114:8080'   // Genesis #5 - Europe
        ];
    }
    
    // CACHE TTL: 10 minutes (server caches for 10 min too)
    static CACHE_TTL = 10 * 60 * 1000;
    
    /**
     * Update live data from server's cached public stats endpoint
     * Server caches data for 10 minutes - safe to call frequently
     */
    async updateLiveData() {
        // CHECK CACHE: Skip if data is fresh
        const now = Date.now();
        if (this.dataAvailable && this.liveData.lastUpdate && 
            (now - this.liveData.lastUpdate) < DynamicPricing.CACHE_TTL) {
            console.log(`[DynamicPricing] 📦 Using cached data (${Math.round((now - this.liveData.lastUpdate) / 1000)}s old)`);
            return;
        }
        
        try {
            // SIMPLE: Get all data from server's cached endpoint
            for (const apiUrl of this.bootstrapNodes) {
                try {
                    const response = await fetch(`${apiUrl}/api/v1/public/stats`, {
                        method: 'GET',
                        headers: { 'Content-Type': 'application/json' },
                        signal: AbortSignal.timeout(5000)
                    });
                    
                    if (response.ok) {
                        const stats = await response.json();
                        this.liveData.activeNodes = stats.active_nodes || 0;
                        this.liveData.totalBurnedPercent = stats.burn_percentage || 0;
                        this.liveData.currentPhase = stats.phase === 2 ? 'phase2' : 'phase1';
                        this.liveData.lastUpdate = now;
                        this.dataAvailable = true;
                        console.log('[DynamicPricing] 📊 Server stats:', stats);
                        return;
                    }
                } catch (e) {
                    continue;
                }
            }
            
            console.error('[DynamicPricing] ❌ All bootstrap nodes unreachable');
            this.dataAvailable = false;
        } catch (error) {
            console.error('[DynamicPricing] ❌ Failed to update live data:', error);
            this.dataAvailable = false;
        }
    }
    
    /**
     * Check if pricing data is available
     */
    isDataAvailable() {
        return this.dataAvailable && this.liveData.activeNodes !== null;
    }
    
    /**
     * Calculate Phase 1 activation cost - Dynamic pricing
     * @throws Error if data not available
     */
    calculatePhase1Cost() {
        if (!this.isDataAvailable()) {
            throw new Error('Pricing data not available - call updateLiveData() first');
        }
        // Calculate reduction based on burn percentage
        const burnPercent = this.liveData.totalBurnedPercent || 0;
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
    /**
     * Calculate Phase 2 activation cost (QNC spending to Pool 3)
     * @throws Error if data not available
     */
    calculatePhase2Cost(nodeType) {
        if (!this.isDataAvailable()) {
            throw new Error('Pricing data not available - call updateLiveData() first');
        }
        const baseCost = this.PHASE_2_BASE_COSTS[nodeType] || this.PHASE_2_BASE_COSTS.full;
        const multiplier = this.getNetworkMultiplier(this.liveData.activeNodes);
        const finalCost = Math.round(baseCost * multiplier);
        
        return {
            cost: finalCost,
            token: 'QNC',
            mechanism: 'transfer', // Transfer to Pool 3, not burn
            description: `Transfer ${finalCost} QNC to Pool #3 for activation`,
            baseCost: baseCost,
            multiplier: multiplier,
            networkSize: this.liveData.activeNodes
        };
    }
    
    /**
     * Get activation cost directly from server (recommended)
     * Server calculates price - no client-side manipulation possible
     */
    async getActivationCostFromServer(nodeType = 'light') {
        for (const apiUrl of this.bootstrapNodes) {
            try {
                const response = await fetch(`${apiUrl}/api/v1/activation/price?type=${nodeType}`, {
                    method: 'GET',
                    headers: { 'Content-Type': 'application/json' },
                    signal: AbortSignal.timeout(5000)
                });
                
                if (response.ok) {
                    const pricing = await response.json();
                    console.log('[DynamicPricing] 💰 Server pricing:', pricing);
                    return pricing;
                }
            } catch (e) {
                continue;
            }
        }
        throw new Error('Unable to get pricing from server');
    }
    
    /**
     * Get activation cost for any node type (local calculation - fallback)
     * @throws Error if data not available
     */
    getActivationCost(nodeType = 'light') {
        if (!this.isDataAvailable()) {
            throw new Error('Pricing data not available - call updateLiveData() first');
        }
        if (this.liveData.currentPhase === 'phase1') {
            return this.calculatePhase1Cost();
        } else {
            return this.calculatePhase2Cost(nodeType);
        }
    }
    
    /**
     * Get detailed pricing information for UI display
     */
    getPricingInfo() {
        if (this.liveData.currentPhase === 'phase1') {
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
        const burnedPercent = this.liveData.totalBurnedPercent;
        const timePassed = 0; // Mock: years since launch
        
        return burnedPercent >= this.BURN_TARGET_PERCENT || timePassed >= this.TIME_LIMIT_YEARS;
    }
    
    /**
     * Update live data manually (for testing or manual override)
     */
    updateData(data) {
        this.liveData = { ...this.liveData, ...data };
    }
    
    /**
     * Get current phase information
     */
    getCurrentPhase() {
        return {
            phase: this.liveData.currentPhase,
            burnedPercent: this.liveData.totalBurnedPercent,
            activeNodes: this.liveData.activeNodes,
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
