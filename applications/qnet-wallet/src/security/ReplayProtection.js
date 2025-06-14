// QNet Replay Attack Protection

export class ReplayProtection {
    constructor() {
        this.processedTxs = new Map();
        this.maxAge = 24 * 60 * 60 * 1000; // 24 hours
        this.cleanupInterval = 60 * 60 * 1000; // 1 hour
        
        // Start cleanup timer
        this.startCleanup();
    }
    
    // Check if transaction is replay
    async checkTransaction(tx) {
        const txId = await this.generateTxId(tx);
        
        // Check if already processed
        if (this.processedTxs.has(txId)) {
            const processedAt = this.processedTxs.get(txId);
            return {
                isReplay: true,
                processedAt,
                txId
            };
        }
        
        // Check timestamp validity
        const now = Date.now();
        const txAge = now - tx.timestamp;
        
        if (txAge > this.maxAge) {
            return {
                isReplay: true,
                reason: 'Transaction too old',
                maxAge: this.maxAge,
                txAge
            };
        }
        
        if (tx.timestamp > now + 5 * 60 * 1000) { // 5 minutes in future
            return {
                isReplay: true,
                reason: 'Transaction timestamp in future',
                timestamp: tx.timestamp,
                now
            };
        }
        
        // Mark as processed
        this.processedTxs.set(txId, now);
        
        return {
            isReplay: false,
            txId
        };
    }
    
    // Generate unique transaction ID
    async generateTxId(tx) {
        // Create canonical transaction data
        const canonicalTx = {
            from: tx.from,
            to: tx.to,
            amount: tx.amount,
            nonce: tx.nonce,
            timestamp: tx.timestamp,
            chainId: tx.chainId || 'qnet-mainnet'
        };
        
        const txData = JSON.stringify(canonicalTx);
        const encoder = new TextEncoder();
        const data = encoder.encode(txData);
        
        // Hash to get unique ID
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        
        return hashHex;
    }
    
    // Add chain ID to transaction
    addChainProtection(tx, chainId = 'qnet-mainnet') {
        return {
            ...tx,
            chainId,
            version: 2 // Transaction version with replay protection
        };
    }
    
    // Verify chain ID
    verifyChainId(tx, expectedChainId = 'qnet-mainnet') {
        if (!tx.chainId) {
            return {
                valid: false,
                reason: 'Missing chain ID'
            };
        }
        
        if (tx.chainId !== expectedChainId) {
            return {
                valid: false,
                reason: 'Invalid chain ID',
                expected: expectedChainId,
                actual: tx.chainId
            };
        }
        
        return { valid: true };
    }
    
    // Clean up old transactions
    cleanup() {
        const now = Date.now();
        const cutoff = now - this.maxAge;
        
        for (const [txId, processedAt] of this.processedTxs.entries()) {
            if (processedAt < cutoff) {
                this.processedTxs.delete(txId);
            }
        }
    }
    
    // Start periodic cleanup
    startCleanup() {
        setInterval(() => {
            this.cleanup();
        }, this.cleanupInterval);
    }
    
    // Get statistics
    getStats() {
        return {
            processedCount: this.processedTxs.size,
            oldestTx: Math.min(...this.processedTxs.values()),
            newestTx: Math.max(...this.processedTxs.values())
        };
    }
} 