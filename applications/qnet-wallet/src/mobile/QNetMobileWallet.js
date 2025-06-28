/**
 * QNet Mobile Wallet - Production Implementation
 * Complete mobile wallet with dual-network architecture
 */

import { QNetDualWallet } from '../wallet/QNetDualWallet.js';
import { NetworkConfig } from '../config/NetworkConfig.js';
import { DAppBrowser } from './DAppBrowser.js';

export class QNetMobileWallet {
    constructor() {
        this.dualWallet = null;
        this.dappBrowser = null;
        this.config = new NetworkConfig();
        this.isProduction = this.config.isProduction();
        
        // Mobile-specific settings
        this.settings = {
            biometricAuth: false,
            autoLock: true,
            autoLockTimeout: 300000, // 5 minutes
            backgroundRefresh: true,
            pushNotifications: true,
            hapticFeedback: true
        };
        
        // Mobile state
        this.isBackground = false;
        this.lastActivity = Date.now();
        this.lockTimer = null;
        
        // Performance optimization
        this.lowPowerMode = false;
        this.connectionRetries = 0;
        this.maxRetries = 3;
        
        this.init();
    }

    /**
     * Initialize mobile wallet
     */
    async init() {
        try {
            console.log('Initializing QNet Mobile Wallet...');
            
            // Initialize dual wallet
            this.dualWallet = new QNetDualWallet();
            await this.dualWallet.initialize();
            
            // Initialize DApp browser
            this.dappBrowser = new DAppBrowser(this.dualWallet);
            
            // Setup mobile-specific features
            this.setupMobileFeatures();
            this.setupBackgroundHandling();
            this.setupBiometricAuth();
            this.setupPushNotifications();
            
            // Start monitoring
            this.startActivityMonitoring();
            this.startPerformanceMonitoring();
            
            console.log('QNet Mobile Wallet initialized successfully');
            
        } catch (error) {
            console.error('Failed to initialize mobile wallet:', error);
            throw error;
        }
    }

    /**
     * Setup mobile-specific features
     */
    setupMobileFeatures() {
        // Auto-lock functionality
        if (this.settings.autoLock) {
            this.setupAutoLock();
        }
        
        // Haptic feedback
        if (this.settings.hapticFeedback && navigator.vibrate) {
            this.enableHapticFeedback();
        }
        
        // Network change detection
        if (navigator.connection) {
            navigator.connection.addEventListener('change', this.handleNetworkChange.bind(this));
        }
        
        // Visibility change handling
        document.addEventListener('visibilitychange', this.handleVisibilityChange.bind(this));
        
        // Device orientation handling
        window.addEventListener('orientationchange', this.handleOrientationChange.bind(this));
    }

    /**
     * Setup background handling
     */
    setupBackgroundHandling() {
        // Page visibility API
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                this.handleAppBackground();
            } else {
                this.handleAppForeground();
            }
        });
        
        // Pause/resume events for mobile
        window.addEventListener('pagehide', this.handleAppBackground.bind(this));
        window.addEventListener('pageshow', this.handleAppForeground.bind(this));
    }

    /**
     * Setup biometric authentication
     */
    async setupBiometricAuth() {
        if (!navigator.credentials || !window.PublicKeyCredential) {
            console.log('Biometric authentication not supported');
            return;
        }
        
        try {
            // Check if biometric auth is available
            const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
            
            if (available) {
                this.biometricAvailable = true;
                console.log('Biometric authentication available');
            }
        } catch (error) {
            console.warn('Biometric setup failed:', error);
        }
    }

    /**
     * Setup push notifications
     */
    async setupPushNotifications() {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            console.log('Push notifications not supported');
            return;
        }
        
        try {
            // Register service worker
            const registration = await navigator.serviceWorker.register('/sw.js');
            
            // Request notification permission
            if (this.settings.pushNotifications) {
                const permission = await Notification.requestPermission();
                
                if (permission === 'granted') {
                    console.log('Push notifications enabled');
                    this.notificationsEnabled = true;
                }
            }
        } catch (error) {
            console.warn('Push notification setup failed:', error);
        }
    }

    /**
     * Setup auto-lock functionality
     */
    setupAutoLock() {
        this.resetAutoLockTimer();
        
        // Listen for user activity
        const events = ['touchstart', 'touchmove', 'touchend', 'click', 'scroll'];
        events.forEach(event => {
            document.addEventListener(event, this.handleUserActivity.bind(this), { passive: true });
        });
    }

    /**
     * Handle user activity
     */
    handleUserActivity() {
        this.lastActivity = Date.now();
        this.resetAutoLockTimer();
    }

    /**
     * Reset auto-lock timer
     */
    resetAutoLockTimer() {
        if (this.lockTimer) {
            clearTimeout(this.lockTimer);
        }
        
        if (this.settings.autoLock && !this.dualWallet?.locked) {
            this.lockTimer = setTimeout(() => {
                this.autoLockWallet();
            }, this.settings.autoLockTimeout);
        }
    }

    /**
     * Auto-lock wallet
     */
    async autoLockWallet() {
        try {
            if (this.dualWallet && !this.dualWallet.locked) {
                await this.dualWallet.lockWallet();
                this.showNotification('Wallet Locked', 'Wallet automatically locked for security');
                this.triggerHapticFeedback('light');
            }
        } catch (error) {
            console.error('Auto-lock failed:', error);
        }
    }

    /**
     * Handle app going to background
     */
    handleAppBackground() {
        this.isBackground = true;
        
        // Reduce update frequency
        if (this.settings.backgroundRefresh) {
            this.setLowPowerMode(true);
        }
        
        // Lock immediately if sensitive operations are active
        if (this.dualWallet && !this.dualWallet.locked) {
            setTimeout(() => {
                if (this.isBackground) {
                    this.autoLockWallet();
                }
            }, 30000); // 30 seconds
        }
    }

    /**
     * Handle app coming to foreground
     */
    handleAppForeground() {
        this.isBackground = false;
        this.setLowPowerMode(false);
        
        // Reset activity timer
        this.handleUserActivity();
        
        // Check for updates
        if (this.dualWallet && !this.dualWallet.locked) {
            this.refreshWalletData();
        }
    }

    /**
     * Handle network changes
     */
    handleNetworkChange() {
        const connection = navigator.connection;
        if (!connection) return;
        
        console.log('Network changed:', {
            type: connection.effectiveType,
            downlink: connection.downlink,
            rtt: connection.rtt
        });
        
        // Adjust behavior based on connection quality
        if (connection.effectiveType === 'slow-2g' || connection.effectiveType === '2g') {
            this.setLowPowerMode(true);
        } else {
            this.setLowPowerMode(false);
        }
        
        // Retry failed connections
        if (this.connectionRetries < this.maxRetries) {
            this.retryConnections();
        }
    }

    /**
     * Handle device orientation change
     */
    handleOrientationChange() {
        // Trigger layout recalculation
        setTimeout(() => {
            window.dispatchEvent(new Event('resize'));
        }, 100);
    }

    /**
     * Set low power mode
     */
    setLowPowerMode(enabled) {
        this.lowPowerMode = enabled;
        
        if (enabled) {
            // Reduce update frequency
            console.log('Low power mode enabled');
        } else {
            // Resume normal operation
            console.log('Low power mode disabled');
        }
    }

    /**
     * Start activity monitoring
     */
    startActivityMonitoring() {
        setInterval(() => {
            const inactiveTime = Date.now() - this.lastActivity;
            
            // Check for prolonged inactivity
            if (inactiveTime > 600000 && !this.dualWallet?.locked) { // 10 minutes
                this.autoLockWallet();
            }
        }, 60000); // Check every minute
    }

    /**
     * Start performance monitoring
     */
    startPerformanceMonitoring() {
        if (!performance.memory) return;
        
        setInterval(() => {
            const memory = performance.memory;
            const memoryUsage = memory.usedJSHeapSize / memory.jsHeapSizeLimit;
            
            // Warn if memory usage is high
            if (memoryUsage > 0.8) {
                console.warn('High memory usage detected:', memoryUsage);
                this.optimizeMemoryUsage();
            }
        }, 30000); // Check every 30 seconds
    }

    /**
     * Optimize memory usage
     */
    optimizeMemoryUsage() {
        // Clear caches
        if (this.dualWallet) {
            this.dualWallet.clearCaches?.();
        }
        
        // Garbage collection hint
        if (window.gc) {
            window.gc();
        }
    }

    /**
     * Retry failed connections
     */
    async retryConnections() {
        this.connectionRetries++;
        
        try {
            if (this.dualWallet) {
                await this.dualWallet.networkManager.reconnect();
            }
            
            this.connectionRetries = 0; // Reset on success
        } catch (error) {
            console.error('Connection retry failed:', error);
        }
    }

    /**
     * Refresh wallet data
     */
    async refreshWalletData() {
        if (!this.dualWallet || this.dualWallet.locked) return;
        
        try {
            await this.dualWallet.updateAllBalances();
        } catch (error) {
            console.error('Failed to refresh wallet data:', error);
        }
    }

    /**
     * Enable haptic feedback
     */
    enableHapticFeedback() {
        this.hapticEnabled = true;
    }

    /**
     * Trigger haptic feedback
     */
    triggerHapticFeedback(type = 'light') {
        if (!this.hapticEnabled || !navigator.vibrate) return;
        
        const patterns = {
            light: [10],
            medium: [20],
            heavy: [30],
            success: [10, 50, 10],
            error: [50, 30, 50, 30, 50]
        };
        
        navigator.vibrate(patterns[type] || patterns.light);
    }

    /**
     * Show notification
     */
    showNotification(title, message, options = {}) {
        if (!this.notificationsEnabled) return;
        
        if (Notification.permission === 'granted') {
            new Notification(title, {
                body: message,
                icon: '/icons/icon-192.png',
                badge: '/icons/icon-192.png',
                ...options
            });
        }
    }

    /**
     * Create wallet with mobile optimizations
     */
    async createWallet(password, seedPhrase = null) {
        try {
            this.triggerHapticFeedback('light');
            
            const result = await this.dualWallet.createWallet(password, seedPhrase);
            
            if (result.success) {
                this.triggerHapticFeedback('success');
                this.showNotification(
                    'Wallet Created',
                    'Your QNet wallet has been created successfully'
                );
            }
            
            return result;
        } catch (error) {
            this.triggerHapticFeedback('error');
            throw error;
        }
    }

    /**
     * Unlock wallet with biometric auth
     */
    async unlockWallet(password, useBiometric = false) {
        try {
            if (useBiometric && this.biometricAvailable) {
                const biometricResult = await this.authenticateWithBiometric();
                if (!biometricResult.success) {
                    throw new Error('Biometric authentication failed');
                }
            }
            
            this.triggerHapticFeedback('light');
            
            const result = await this.dualWallet.unlockWallet(password);
            
            this.triggerHapticFeedback('success');
            this.resetAutoLockTimer();
            
            return result;
        } catch (error) {
            this.triggerHapticFeedback('error');
            throw error;
        }
    }

    /**
     * Authenticate with biometric
     */
    async authenticateWithBiometric() {
        if (!this.biometricAvailable) {
            return { success: false, error: 'Biometric authentication not available' };
        }
        
        try {
            const credential = await navigator.credentials.create({
                publicKey: {
                    challenge: new Uint8Array(32),
                    rp: { name: 'QNet Wallet' },
                    user: {
                        id: new Uint8Array(16),
                        name: 'user',
                        displayName: 'QNet User'
                    },
                    pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
                    authenticatorSelection: {
                        userVerification: 'required'
                    }
                }
            });
            
            return { success: true, credential };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Activate node with mobile feedback
     */
    async activateNode(nodeType) {
        try {
            this.triggerHapticFeedback('light');
            
            const result = await this.dualWallet.activateNode(nodeType);
            
            if (result.success) {
                this.triggerHapticFeedback('success');
                this.showNotification(
                    'Node Activated',
                    `Your ${nodeType} node has been activated successfully`
                );
            }
            
            return result;
        } catch (error) {
            this.triggerHapticFeedback('error');
            throw error;
        }
    }

    /**
     * Switch network with mobile feedback
     */
    async switchNetwork(network) {
        try {
            this.triggerHapticFeedback('light');
            
            await this.dualWallet.switchNetwork(network);
            
            this.triggerHapticFeedback('medium');
            this.showNotification(
                'Network Switched',
                `Switched to ${network.toUpperCase()} network`
            );
        } catch (error) {
            this.triggerHapticFeedback('error');
            throw error;
        }
    }

    /**
     * Get mobile-optimized wallet state
     */
    getMobileWalletState() {
        const baseState = this.dualWallet?.getWalletState() || {};
        
        return {
            ...baseState,
            mobile: {
                isBackground: this.isBackground,
                lowPowerMode: this.lowPowerMode,
                lastActivity: this.lastActivity,
                biometricAvailable: this.biometricAvailable,
                notificationsEnabled: this.notificationsEnabled,
                hapticEnabled: this.hapticEnabled,
                settings: this.settings
            }
        };
    }

    /**
     * Update mobile settings
     */
    updateSettings(newSettings) {
        this.settings = { ...this.settings, ...newSettings };
        
        // Apply settings changes
        if (newSettings.autoLock !== undefined) {
            if (newSettings.autoLock) {
                this.setupAutoLock();
            } else if (this.lockTimer) {
                clearTimeout(this.lockTimer);
            }
        }
        
        if (newSettings.hapticFeedback !== undefined) {
            this.hapticEnabled = newSettings.hapticFeedback;
        }
    }

    /**
     * Get performance metrics
     */
    getPerformanceMetrics() {
        const memory = performance.memory;
        
        return {
            memory: memory ? {
                used: memory.usedJSHeapSize,
                total: memory.totalJSHeapSize,
                limit: memory.jsHeapSizeLimit,
                usage: memory.usedJSHeapSize / memory.jsHeapSizeLimit
            } : null,
            connection: navigator.connection ? {
                type: navigator.connection.effectiveType,
                downlink: navigator.connection.downlink,
                rtt: navigator.connection.rtt
            } : null,
            lowPowerMode: this.lowPowerMode,
            backgroundTime: this.isBackground ? Date.now() - this.lastActivity : 0
        };
    }

    /**
     * Cleanup mobile wallet
     */
    destroy() {
        // Clear timers
        if (this.lockTimer) {
            clearTimeout(this.lockTimer);
        }
        
        // Remove event listeners
        document.removeEventListener('visibilitychange', this.handleVisibilityChange);
        window.removeEventListener('orientationchange', this.handleOrientationChange);
        
        // Cleanup wallet
        if (this.dualWallet) {
            this.dualWallet.destroy?.();
        }
        
        // Cleanup DApp browser
        if (this.dappBrowser) {
            this.dappBrowser.destroy?.();
        }
    }
} 