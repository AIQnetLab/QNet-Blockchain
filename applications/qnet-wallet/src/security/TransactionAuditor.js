// QNet Transaction Auditor

export class TransactionAuditor {
    constructor() {
        this.auditLog = [];
        this.suspiciousPatterns = new Map();
        this.maxLogSize = 1000;
        
        // Initialize suspicious patterns
        this.initializePatterns();
    }
    
    // Initialize suspicious patterns
    initializePatterns() {
        // High value transactions
        this.suspiciousPatterns.set('high_value', {
            check: (tx) => Number(tx.amount) > 10000,
            severity: 'medium',
            description: 'High value transaction'
        });
        
        // Rapid transactions
        this.suspiciousPatterns.set('rapid_tx', {
            check: (tx, history) => {
                const recentTxs = history.filter(h => 
                    h.from === tx.from && 
                    tx.timestamp - h.timestamp < 60000 // 1 minute
                );
                return recentTxs.length > 5;
            },
            severity: 'high',
            description: 'Too many transactions in short time'
        });
        
        // Unusual hours
        this.suspiciousPatterns.set('unusual_hours', {
            check: (tx) => {
                const hour = new Date(tx.timestamp).getHours();
                return hour >= 2 && hour <= 5; // 2 AM - 5 AM
            },
            severity: 'low',
            description: 'Transaction at unusual hour'
        });
        
        // New recipient with high value
        this.suspiciousPatterns.set('new_recipient_high_value', {
            check: (tx, history) => {
                const isNewRecipient = !history.some(h => h.to === tx.to);
                const isHighValue = Number(tx.amount) > 1000;
                return isNewRecipient && isHighValue;
            },
            severity: 'high',
            description: 'High value to new recipient'
        });
        
        // Draining account
        this.suspiciousPatterns.set('account_drain', {
            check: (tx, history, balance) => {
                if (!balance) return false;
                const remaining = Number(balance) - Number(tx.amount);
                return remaining < Number(balance) * 0.1; // Less than 10% remaining
            },
            severity: 'high',
            description: 'Transaction drains most of account balance'
        });
    }
    
    // Audit transaction
    async auditTransaction(tx, userHistory = [], balance = null) {
        const auditEntry = {
            txId: await this.generateTxId(tx),
            timestamp: Date.now(),
            transaction: {
                from: tx.from,
                to: tx.to,
                amount: tx.amount,
                timestamp: tx.timestamp
            },
            flags: [],
            score: 0
        };
        
        // Check all patterns
        for (const [patternName, pattern] of this.suspiciousPatterns) {
            try {
                if (pattern.check(tx, userHistory, balance)) {
                    auditEntry.flags.push({
                        pattern: patternName,
                        severity: pattern.severity,
                        description: pattern.description
                    });
                    
                    // Update score based on severity
                    switch (pattern.severity) {
                        case 'low':
                            auditEntry.score += 1;
                            break;
                        case 'medium':
                            auditEntry.score += 5;
                            break;
                        case 'high':
                            auditEntry.score += 10;
                            break;
                    }
                }
            } catch (error) {
                console.error(`Error checking pattern ${patternName}:`, error);
            }
        }
        
        // Determine risk level
        if (auditEntry.score >= 15) {
            auditEntry.riskLevel = 'critical';
        } else if (auditEntry.score >= 10) {
            auditEntry.riskLevel = 'high';
        } else if (auditEntry.score >= 5) {
            auditEntry.riskLevel = 'medium';
        } else if (auditEntry.score > 0) {
            auditEntry.riskLevel = 'low';
        } else {
            auditEntry.riskLevel = 'none';
        }
        
        // Add to audit log
        this.addToLog(auditEntry);
        
        return auditEntry;
    }
    
    // Add entry to audit log
    addToLog(entry) {
        this.auditLog.push(entry);
        
        // Maintain max log size
        if (this.auditLog.length > this.maxLogSize) {
            this.auditLog.shift();
        }
        
        // Persist critical entries
        if (entry.riskLevel === 'critical' || entry.riskLevel === 'high') {
            this.persistCriticalEntry(entry);
        }
    }
    
    // Persist critical audit entries
    async persistCriticalEntry(entry) {
        try {
            // Get existing critical entries
            const stored = await chrome.storage.local.get('criticalAudits');
            const criticalAudits = stored.criticalAudits || [];
            
            // Add new entry
            criticalAudits.push({
                ...entry,
                persistedAt: Date.now()
            });
            
            // Keep only last 100 critical entries
            if (criticalAudits.length > 100) {
                criticalAudits.splice(0, criticalAudits.length - 100);
            }
            
            // Save back
            await chrome.storage.local.set({ criticalAudits });
        } catch (error) {
            console.error('Error persisting critical audit:', error);
        }
    }
    
    // Get audit summary
    getAuditSummary(timeRange = 24 * 60 * 60 * 1000) { // 24 hours default
        const cutoff = Date.now() - timeRange;
        const recentEntries = this.auditLog.filter(entry => entry.timestamp > cutoff);
        
        const summary = {
            totalTransactions: recentEntries.length,
            riskBreakdown: {
                critical: 0,
                high: 0,
                medium: 0,
                low: 0,
                none: 0
            },
            topPatterns: new Map(),
            timeRange
        };
        
        // Analyze entries
        for (const entry of recentEntries) {
            summary.riskBreakdown[entry.riskLevel]++;
            
            // Count patterns
            for (const flag of entry.flags) {
                const count = summary.topPatterns.get(flag.pattern) || 0;
                summary.topPatterns.set(flag.pattern, count + 1);
            }
        }
        
        // Convert top patterns to array
        summary.topPatterns = Array.from(summary.topPatterns.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([pattern, count]) => ({ pattern, count }));
        
        return summary;
    }
    
    // Get recent suspicious transactions
    getSuspiciousTransactions(limit = 10) {
        return this.auditLog
            .filter(entry => entry.riskLevel !== 'none')
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }
    
    // Check if should block transaction
    shouldBlockTransaction(auditResult) {
        // Block only critical risk transactions
        return auditResult.riskLevel === 'critical' && auditResult.score >= 20;
    }
    
    // Generate transaction ID
    async generateTxId(tx) {
        const txData = JSON.stringify({
            from: tx.from,
            to: tx.to,
            amount: tx.amount,
            timestamp: tx.timestamp,
            nonce: tx.nonce
        });
        
        const encoder = new TextEncoder();
        const data = encoder.encode(txData);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }
    
    // Export audit log
    exportAuditLog() {
        return {
            exported: Date.now(),
            entries: this.auditLog,
            summary: this.getAuditSummary()
        };
    }
} 