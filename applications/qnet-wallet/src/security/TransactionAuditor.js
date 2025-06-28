// QNet Transaction Auditor - Simple Implementation

export class TransactionAuditor {
    constructor() {
        this.suspiciousPatterns = [
            // Large amounts
            { pattern: 'large_amount', threshold: 10000 },
            // Frequent transactions
            { pattern: 'high_frequency', threshold: 10 },
            // Round numbers (often used in scams)
            { pattern: 'round_number', threshold: 1 }
        ];
    }

    // Audit a transaction for suspicious activity
    async auditTransaction(tx, txHistory = [], balance = 0) {
        const flags = [];
        let score = 0;
        let riskLevel = 'low';

        // Check transaction amount
        const amount = parseFloat(tx.amount);
        if (amount > 10000) {
            flags.push('Large transaction amount');
            score += 30;
        }

        // Check if round number
        if (amount % 1000 === 0) {
            flags.push('Round number transaction');
            score += 10;
        }

        // Check transaction frequency
        const recentTxs = txHistory.filter(t => 
            Date.now() - t.timestamp < 3600000 // Last hour
        );
        if (recentTxs.length > 5) {
            flags.push('High transaction frequency');
            score += 20;
        }

        // Check if spending more than 50% of balance
        if (amount > balance * 0.5) {
            flags.push('Large percentage of balance');
            score += 25;
        }

        // Determine risk level
        if (score >= 50) {
            riskLevel = 'critical';
        } else if (score >= 30) {
            riskLevel = 'high';
        } else if (score >= 15) {
            riskLevel = 'medium';
        }

        return {
            score,
            riskLevel,
            flags,
            timestamp: Date.now()
        };
    }

    // Check if transaction should be blocked
    shouldBlockTransaction(auditResult) {
        return auditResult.riskLevel === 'critical' && auditResult.score >= 60;
    }
} 