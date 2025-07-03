/**
 * Single Node Enforcement - Production Security
 * Prevents multiple node activation attempts per wallet
 * Implements hardware fingerprinting and anti-fraud measures
 */

export class SingleNodeEnforcement {
    constructor() {
        this.activationAttempts = new Map();
        this.deviceFingerprints = new Set();
        this.maxAttemptsPerDevice = 1;
        this.cooldownPeriod = 24 * 60 * 60 * 1000; // 24 hours
    }

    /**
     * Generate device fingerprint for anti-fraud protection
     */
    async generateDeviceFingerprint() {
        try {
            const components = [
                navigator.userAgent,
                navigator.language,
                screen.width,
                screen.height,
                screen.colorDepth,
                new Date().getTimezoneOffset(),
                navigator.platform,
                navigator.hardwareConcurrency || 'unknown'
            ];

            // Add WebGL fingerprint if available
            const canvas = document.createElement('canvas');
            const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
            if (gl) {
                components.push(
                    gl.getParameter(gl.RENDERER),
                    gl.getParameter(gl.VENDOR)
                );
            }

            // Create hash of components
            const fingerprint = await this.hashComponents(components.join('|'));
            return fingerprint;

        } catch (error) {
            console.error('Error generating device fingerprint:', error);
            // Fallback fingerprint
            return await this.hashComponents(navigator.userAgent + Date.now());
        }
    }

    /**
     * Hash components for fingerprinting
     */
    async hashComponents(data) {
        const encoder = new TextEncoder();
        const dataBuffer = encoder.encode(data);
        const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
        const hashArray = new Uint8Array(hashBuffer);
        return Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Check if node activation is allowed for this device
     */
    async checkActivationEligibility(walletAddress) {
        try {
            const deviceFingerprint = await this.generateDeviceFingerprint();
            const currentTime = Date.now();
            
            // Check if device already has an active node
            if (this.deviceFingerprints.has(deviceFingerprint)) {
                return {
                    allowed: false,
                    reason: 'DEVICE_ALREADY_ACTIVATED',
                    message: 'This device already has an active node. Only one node per device is allowed.'
                };
            }

            // Check activation attempts from this device
            const attemptKey = `${deviceFingerprint}:${walletAddress}`;
            const lastAttempt = this.activationAttempts.get(attemptKey);
            
            if (lastAttempt) {
                const timeSinceLastAttempt = currentTime - lastAttempt.timestamp;
                
                if (timeSinceLastAttempt < this.cooldownPeriod) {
                    const remainingTime = Math.ceil((this.cooldownPeriod - timeSinceLastAttempt) / (60 * 60 * 1000));
                    return {
                        allowed: false,
                        reason: 'COOLDOWN_ACTIVE',
                        message: `Please wait ${remainingTime} hours before attempting activation again.`,
                        remainingHours: remainingTime
                    };
                }

                if (lastAttempt.count >= this.maxAttemptsPerDevice) {
                    return {
                        allowed: false,
                        reason: 'MAX_ATTEMPTS_EXCEEDED',
                        message: 'Maximum activation attempts exceeded for this device.'
                    };
                }
            }

            return {
                allowed: true,
                deviceFingerprint,
                message: 'Node activation is allowed for this device.'
            };

        } catch (error) {
            console.error('Error checking activation eligibility:', error);
            return {
                allowed: false,
                reason: 'SYSTEM_ERROR',
                message: 'Unable to verify activation eligibility. Please try again.'
            };
        }
    }

    /**
     * Record activation attempt
     */
    recordActivationAttempt(deviceFingerprint, walletAddress, success = false) {
        const attemptKey = `${deviceFingerprint}:${walletAddress}`;
        const currentTime = Date.now();
        
        const existingAttempt = this.activationAttempts.get(attemptKey);
        
        this.activationAttempts.set(attemptKey, {
            timestamp: currentTime,
            count: existingAttempt ? existingAttempt.count + 1 : 1,
            lastSuccess: success ? currentTime : (existingAttempt?.lastSuccess || null),
            walletAddress
        });

        if (success) {
            this.deviceFingerprints.add(deviceFingerprint);
        }

        console.log(`Activation attempt recorded: ${success ? 'SUCCESS' : 'FAILED'}`);
    }

    /**
     * Get activation statistics
     */
    getActivationStats() {
        return {
            totalDevices: this.deviceFingerprints.size,
            totalAttempts: this.activationAttempts.size,
            activeNodes: this.deviceFingerprints.size
        };
    }

    /**
     * Clear old activation attempts (cleanup)
     */
    cleanupOldAttempts() {
        const currentTime = Date.now();
        const cleanupThreshold = 7 * 24 * 60 * 60 * 1000; // 7 days
        
        for (const [key, attempt] of this.activationAttempts.entries()) {
            if (currentTime - attempt.timestamp > cleanupThreshold) {
                this.activationAttempts.delete(key);
            }
        }
    }

    /**
     * Reset device activation (admin function)
     */
    resetDeviceActivation(deviceFingerprint) {
        this.deviceFingerprints.delete(deviceFingerprint);
        
        // Remove all attempts for this device
        for (const [key] of this.activationAttempts.entries()) {
            if (key.startsWith(deviceFingerprint + ':')) {
                this.activationAttempts.delete(key);
            }
        }
        
        console.log('Device activation reset:', deviceFingerprint);
    }

    /**
     * Export data for persistence
     */
    exportData() {
        return {
            activationAttempts: Array.from(this.activationAttempts.entries()),
            deviceFingerprints: Array.from(this.deviceFingerprints),
            timestamp: Date.now()
        };
    }

    /**
     * Import data from persistence
     */
    importData(data) {
        if (data && data.activationAttempts) {
            this.activationAttempts = new Map(data.activationAttempts);
        }
        
        if (data && data.deviceFingerprints) {
            this.deviceFingerprints = new Set(data.deviceFingerprints);
        }
    }
}

// Export singleton instance
export const singleNodeEnforcer = new SingleNodeEnforcement();
export default SingleNodeEnforcement; 