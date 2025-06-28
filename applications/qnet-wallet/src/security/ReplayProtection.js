// QNet Replay Protection - Simple Implementation

export class ReplayProtection {
    constructor() {
        this.usedNonces = new Set();
        this.chainId = 'qnet-mainnet';
    }

    // Add chain-specific protection to transaction
    addChainProtection(tx) {
        return {
            ...tx,
            chainId: this.chainId,
            nonce: tx.nonce || Date.now()
        };
    }

    // Check if transaction has been used before
    isReplayAttack(tx) {
        const txKey = `${tx.from}:${tx.nonce}:${tx.chainId}`;
        return this.usedNonces.has(txKey);
    }

    // Mark transaction as used
    markAsUsed(tx) {
        const txKey = `${tx.from}:${tx.nonce}:${tx.chainId}`;
        this.usedNonces.add(txKey);
    }

    // Clean up old nonces (in production, would use persistent storage)
    cleanup() {
        // Simple cleanup - in production would be more sophisticated
        if (this.usedNonces.size > 10000) {
            this.usedNonces.clear();
        }
    }
} 