// QNet Rate Limiter - Simple Implementation

export class RateLimiter {
    constructor() {
        this.limits = new Map();
        this.requests = new Map();
    }

    // Set rate limits for specific actions
    static getLimits(action) {
        const limits = {
            'api_call': { requests: 100, window: 60000 }, // 100 requests per minute
            'dapp_connect': { requests: 10, window: 60000 }, // 10 connections per minute
            'bulk_sign': { requests: 5, window: 60000 } // 5 bulk signs per minute
        };
        
        return limits[action] || null;
    }

    // Check if request is within rate limits
    async checkLimit(action, identifier, limits) {
        const key = `${action}:${identifier}`;
        const now = Date.now();
        
        if (!this.requests.has(key)) {
            this.requests.set(key, []);
        }
        
        const requests = this.requests.get(key);
        
        // Remove old requests outside the window
        const validRequests = requests.filter(timestamp => 
            now - timestamp < limits.window
        );
        
        // Check if over limit
        if (validRequests.length >= limits.requests) {
            throw new Error(`Rate limit exceeded for ${action}`);
        }
        
        // Add current request
        validRequests.push(now);
        this.requests.set(key, validRequests);
        
        return true;
    }

    // Cleanup old entries
    cleanup() {
        const now = Date.now();
        const maxAge = 300000; // 5 minutes
        
        for (const [key, requests] of this.requests.entries()) {
            const validRequests = requests.filter(timestamp => 
                now - timestamp < maxAge
            );
            
            if (validRequests.length === 0) {
                this.requests.delete(key);
            } else {
                this.requests.set(key, validRequests);
            }
        }
    }
} 