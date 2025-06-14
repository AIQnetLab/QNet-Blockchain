// QNet Rate Limiter Module - Simplified

export class RateLimiter {
    constructor() {
        this.attempts = new Map();
        this.blocked = new Map();
    }
    
    // Check if action is allowed
    async checkLimit(action, identifier, limits) {
        const key = `${action}:${identifier}`;
        const now = Date.now();
        
        // Check if blocked
        const blockExpiry = this.blocked.get(key);
        if (blockExpiry && blockExpiry > now) {
            const minutesLeft = Math.ceil((blockExpiry - now) / 60000);
            throw new Error(`Too many requests. Please wait ${minutesLeft} minutes.`);
        }
        
        // Get attempts history
        let history = this.attempts.get(key) || [];
        
        // Clean old attempts
        history = history.filter(timestamp => 
            now - timestamp < limits.windowMs
        );
        
        // Check limits
        if (history.length >= limits.maxAttempts) {
            // Block for specified duration
            const blockDuration = limits.blockDurationMs || 15 * 60 * 1000; // 15 min default
            this.blocked.set(key, now + blockDuration);
            
            // Clear attempts
            this.attempts.delete(key);
            
            const minutesBlocked = Math.ceil(blockDuration / 60000);
            throw new Error(`Rate limit exceeded. Blocked for ${minutesBlocked} minutes.`);
        }
        
        // Add current attempt
        history.push(now);
        this.attempts.set(key, history);
        
        return {
            attemptsUsed: history.length,
            attemptsRemaining: limits.maxAttempts - history.length,
            resetTime: history[0] + limits.windowMs
        };
    }
    
    // Reset limits for identifier
    resetLimit(action, identifier) {
        const key = `${action}:${identifier}`;
        this.attempts.delete(key);
        this.blocked.delete(key);
    }
    
    // Get default limits - only for API protection
    static getLimits(action) {
        const limits = {
            // API calls - prevent DDoS
            'api_call': {
                maxAttempts: 100,
                windowMs: 60 * 1000, // 1 minute
                blockDurationMs: 5 * 60 * 1000 // 5 minutes
            },
            
            // DApp connections - prevent spam
            'dapp_connect': {
                maxAttempts: 20,
                windowMs: 60 * 1000, // 1 minute
                blockDurationMs: 5 * 60 * 1000 // 5 minutes
            },
            
            // Mass signature requests - prevent abuse
            'bulk_sign': {
                maxAttempts: 50,
                windowMs: 60 * 1000, // 1 minute
                blockDurationMs: 5 * 60 * 1000 // 5 minutes
            }
        };
        
        return limits[action] || null;
    }
    
    // Clean up old entries (run periodically)
    cleanup() {
        const now = Date.now();
        
        // Clean attempts
        for (const [key, history] of this.attempts.entries()) {
            const action = key.split(':')[0];
            const limits = RateLimiter.getLimits(action);
            
            if (!limits) {
                this.attempts.delete(key);
                continue;
            }
            
            const validHistory = history.filter(timestamp => 
                now - timestamp < limits.windowMs
            );
            
            if (validHistory.length === 0) {
                this.attempts.delete(key);
            } else {
                this.attempts.set(key, validHistory);
            }
        }
        
        // Clean expired blocks
        for (const [key, expiry] of this.blocked.entries()) {
            if (expiry <= now) {
                this.blocked.delete(key);
            }
        }
    }
} 