/**
 * QNet Dual Wallet - Production Main Entry Point
 * Complete production-ready initialization and error handling
 */

import { QNetDualWallet } from './wallet/QNetDualWallet.js';
import { ProductionInterface } from './ui/ProductionInterface.js';
import { TestnetIntegration } from './integration/TestnetIntegration.js';
import { NetworkConfig } from './config/NetworkConfig.js';
import { I18nManager } from './i18n/index.js';

class QNetWalletApp {
    constructor() {
        this.wallet = null;
        this.interface = null;
        this.testnetIntegration = null;
        this.i18n = null;
        this.config = null;
        this.initialized = false;
        this.errorHandler = null;
        
        // Production monitoring
        this.startTime = Date.now();
        this.errorCount = 0;
        this.lastError = null;
        
        this.init();
    }

    /**
     * Initialize QNet Wallet Application
     */
    async init() {
        try {
            console.log('🚀 Starting QNet Dual Wallet...');
            
            // Initialize configuration
            this.config = new NetworkConfig();
            const environment = this.config.getEnvironment();
            const isProduction = this.config.isProduction();
            
            console.log(`Environment: ${environment} ${isProduction ? '(Production)' : '(Development)'}`);
            
            // Setup global error handling
            this.setupGlobalErrorHandling();
            
            // Initialize internationalization
            this.i18n = new I18nManager();
            await this.i18n.initialize();
            
            // Validate browser compatibility
            this.validateBrowserCompatibility();
            
            // Initialize wallet core
            this.wallet = new QNetDualWallet(this.i18n);
            await this.wallet.initialize();
            
            // Initialize production interface
            this.interface = new ProductionInterface(this.wallet, this.i18n);
            
            // Initialize testnet integration if not in production
            if (!isProduction) {
                this.testnetIntegration = new TestnetIntegration(this.wallet);
                await this.testnetIntegration.init();
                
                // Add testnet debugging tools
                this.addTestnetDebugging();
            }
            
            // Setup wallet event listeners
            this.setupWalletEventListeners();
            
            // Perform health checks
            await this.performHealthChecks();
            
            // Start monitoring
            this.startMonitoring();
            
            this.initialized = true;
            
            console.log('✅ QNet Dual Wallet initialized successfully');
            console.log(`🌐 Networks: Solana + QNet`);
            console.log(`💎 Features: EON addresses, Cross-chain activation, Node management`);
            
            // Show welcome message
            this.showWelcomeMessage();
            
        } catch (error) {
            console.error('❌ Failed to initialize QNet Wallet:', error);
            this.handleCriticalError(error);
        }
    }

    /**
     * Setup global error handling
     */
    setupGlobalErrorHandling() {
        // Catch unhandled promise rejections
        window.addEventListener('unhandledrejection', (event) => {
            console.error('Unhandled promise rejection:', event.reason);
            this.handleError('unhandledRejection', event.reason);
            event.preventDefault();
        });

        // Catch uncaught exceptions
        window.addEventListener('error', (event) => {
            console.error('Uncaught error:', event.error);
            this.handleError('uncaughtException', event.error);
        });

        // Setup custom error handler
        this.errorHandler = {
            report: (error, context) => this.handleError('manual', error, context),
            count: () => this.errorCount,
            lastError: () => this.lastError
        };

        // Make error handler globally available
        window.QNetErrorHandler = this.errorHandler;
    }

    /**
     * Validate browser compatibility
     */
    validateBrowserCompatibility() {
        const requirements = {
            crypto: typeof window.crypto !== 'undefined' && typeof window.crypto.subtle !== 'undefined',
            webSockets: typeof WebSocket !== 'undefined',
            localStorage: typeof localStorage !== 'undefined',
            fetch: typeof fetch !== 'undefined',
            promises: typeof Promise !== 'undefined',
            asyncAwait: true // Modern browsers support this
        };

        const missing = Object.entries(requirements)
            .filter(([key, supported]) => !supported)
            .map(([key]) => key);

        if (missing.length > 0) {
            const error = new Error(`Browser compatibility check failed. Missing: ${missing.join(', ')}`);
            throw error;
        }

        // Check for recommended features
        const recommended = {
            webgl: typeof WebGLRenderingContext !== 'undefined',
            serviceWorker: 'serviceWorker' in navigator,
            notifications: 'Notification' in window
        };

        const missingRecommended = Object.entries(recommended)
            .filter(([key, supported]) => !supported)
            .map(([key]) => key);

        if (missingRecommended.length > 0) {
            console.warn('Missing recommended features:', missingRecommended);
        }

        console.log('✅ Browser compatibility check passed');
    }

    /**
     * Setup wallet event listeners
     */
    setupWalletEventListeners() {
        this.wallet.addListener((event, data) => {
            this.handleWalletEvent(event, data);
        });
    }

    /**
     * Handle wallet events
     */
    handleWalletEvent(event, data) {
        switch (event) {
            case 'walletCreated':
                console.log('Wallet created:', data);
                this.trackEvent('wallet_created', data);
                break;
                
            case 'walletUnlocked':
                console.log('Wallet unlocked:', data);
                this.trackEvent('wallet_unlocked', data);
                break;
                
            case 'nodeActivated':
                console.log('Node activated:', data);
                this.trackEvent('node_activated', data);
                break;
                
            case 'networkSwitched':
                console.log('Network switched:', data);
                this.trackEvent('network_switched', data);
                break;
                
            case 'walletError':
                console.error('Wallet error:', data);
                this.handleError('wallet', new Error(data.error), data.context);
                break;
                
            default:
                console.log('Wallet event:', event, data);
        }
    }

    /**
     * Perform health checks
     */
    async performHealthChecks() {
        const checks = [];

        try {
            // Network configuration check
            const configValidation = this.config.validateConfig();
            checks.push({
                name: 'Configuration',
                status: configValidation.valid ? 'pass' : 'fail',
                details: configValidation.errors
            });

            // Wallet initialization check
            checks.push({
                name: 'Wallet Core',
                status: this.wallet.initialized ? 'pass' : 'fail',
                details: this.wallet.getWalletStats()
            });

            // Network connectivity check
            if (this.config.isProduction()) {
                const healthEndpoints = this.config.getHealthCheckEndpoints();
                
                for (const [network, endpoint] of Object.entries(healthEndpoints)) {
                    try {
                        const response = await fetch(endpoint, { timeout: 10000 });
                        checks.push({
                            name: `${network.toUpperCase()} Network`,
                            status: response.ok ? 'pass' : 'fail',
                            details: { status: response.status, endpoint }
                        });
                    } catch (error) {
                        checks.push({
                            name: `${network.toUpperCase()} Network`,
                            status: 'fail',
                            details: { error: error.message, endpoint }
                        });
                    }
                }
            }

            const failedChecks = checks.filter(check => check.status === 'fail');
            
            if (failedChecks.length > 0) {
                console.warn('Health check failures:', failedChecks);
                
                if (this.config.isProduction()) {
                    // In production, show warning but continue
                    this.interface?.showNotification(
                        'warning', 
                        'Network Issues', 
                        'Some services may be temporarily unavailable'
                    );
                }
            } else {
                console.log('✅ All health checks passed');
            }

            return checks;

        } catch (error) {
            console.error('Health check error:', error);
            return checks;
        }
    }

    /**
     * Start monitoring
     */
    startMonitoring() {
        // Performance monitoring
        setInterval(() => {
            const stats = this.getApplicationStats();
            this.logPerformanceStats(stats);
        }, 60000); // Every minute

        // Memory monitoring
        if (performance.memory) {
            setInterval(() => {
                const memory = performance.memory;
                if (memory.usedJSHeapSize > memory.jsHeapSizeLimit * 0.9) {
                    console.warn('High memory usage detected:', memory);
                }
            }, 30000); // Every 30 seconds
        }

        // Error rate monitoring
        setInterval(() => {
            if (this.errorCount > 10) {
                console.error('High error rate detected:', this.errorCount);
                this.interface?.showNotification(
                    'error',
                    'High Error Rate',
                    'Multiple errors detected. Please refresh the application.'
                );
            }
        }, 300000); // Every 5 minutes
    }

    /**
     * Add testnet debugging tools
     */
    addTestnetDebugging() {
        // Add global testnet functions for debugging
        window.QNetTestnet = {
            runScenario: (name) => this.testnetIntegration.runTestScenario(name),
            getScenarios: () => this.testnetIntegration.getAvailableScenarios(),
            requestFaucet: (network, token, amount) => {
                const address = this.wallet.getCurrentAddress();
                return this.testnetIntegration.requestFromFaucet(network, token, amount, address);
            },
            getStats: () => this.testnetIntegration.getTestnetStats(),
            reset: () => this.testnetIntegration.resetTestnetState()
        };

        // Add debugging console commands
        console.log('🧪 Testnet debugging tools available:');
        console.log('- QNetTestnet.getScenarios() - List test scenarios');
        console.log('- QNetTestnet.runScenario(name) - Run test scenario');
        console.log('- QNetTestnet.requestFaucet(network, token, amount) - Request testnet tokens');
        console.log('- QNetTestnet.getStats() - Get testnet statistics');
    }

    /**
     * Show welcome message
     */
    showWelcomeMessage() {
        const isFirstTime = !localStorage.getItem('qnet_wallet_visited');
        
        if (isFirstTime) {
            localStorage.setItem('qnet_wallet_visited', 'true');
            
            this.interface?.showNotification(
                'info',
                'Welcome to QNet Wallet',
                'Your gateway to the QNet dual-network ecosystem. Create or import a wallet to get started.',
                10000
            );
        }

        // Show environment notice
        if (!this.config.isProduction()) {
            this.interface?.showNotification(
                'warning',
                'Testnet Environment',
                'You are using the testnet version. All transactions are for testing only.',
                8000
            );
        }
    }

    /**
     * Handle errors
     */
    handleError(type, error, context = {}) {
        this.errorCount++;
        this.lastError = {
            type,
            error: error.message,
            stack: error.stack,
            context,
            timestamp: Date.now()
        };

        // Log error
        console.error(`Error [${type}]:`, error, context);

        // Track error for analytics
        this.trackEvent('error', {
            type,
            message: error.message,
            context
        });

        // Show user notification for critical errors
        if (type === 'wallet' || type === 'uncaughtException') {
            this.interface?.showNotification(
                'error',
                'Application Error',
                'An error occurred. Please try again or refresh the page.',
                5000
            );
        }
    }

    /**
     * Handle critical errors
     */
    handleCriticalError(error) {
        console.error('💥 Critical error - application cannot continue:', error);
        
        // Show critical error UI
        document.body.innerHTML = `
            <div style="
                display: flex;
                justify-content: center;
                align-items: center;
                height: 100vh;
                background: #0a0a0a;
                color: #fff;
                font-family: -apple-system, BlinkMacSystemFont, sans-serif;
                text-align: center;
                padding: 20px;
            ">
                <div>
                    <h1 style="color: #f44336; margin-bottom: 20px;">⚠️ Critical Error</h1>
                    <p style="margin-bottom: 20px; max-width: 500px; line-height: 1.5;">
                        QNet Wallet encountered a critical error and cannot continue.
                    </p>
                    <p style="margin-bottom: 30px; font-size: 14px; color: #888;">
                        Error: ${error.message}
                    </p>
                    <button 
                        onclick="window.location.reload()" 
                        style="
                            background: #4a90e2;
                            color: white;
                            border: none;
                            padding: 12px 24px;
                            border-radius: 6px;
                            cursor: pointer;
                            font-size: 16px;
                        "
                    >
                        Reload Application
                    </button>
                </div>
            </div>
        `;
    }

    /**
     * Track events for analytics
     */
    trackEvent(event, data) {
        // This would integrate with analytics service
        if (!this.config.isProduction()) {
            console.log('📊 Event tracked:', event, data);
        }
    }

    /**
     * Log performance statistics
     */
    logPerformanceStats(stats) {
        if (!this.config.isProduction()) {
            console.log('📈 Performance stats:', stats);
        }
    }

    /**
     * Get application statistics
     */
    getApplicationStats() {
        const uptime = Date.now() - this.startTime;
        
        return {
            uptime,
            environment: this.config.getEnvironment(),
            initialized: this.initialized,
            errorCount: this.errorCount,
            walletStats: this.wallet?.getWalletStats(),
            interfaceStats: this.interface?.getInterfaceStats(),
            testnetStats: this.testnetIntegration?.getTestnetStats(),
            memory: performance.memory ? {
                used: performance.memory.usedJSHeapSize,
                total: performance.memory.totalJSHeapSize,
                limit: performance.memory.jsHeapSizeLimit
            } : null,
            timestamp: Date.now()
        };
    }

    /**
     * Restart application
     */
    async restart() {
        try {
            console.log('🔄 Restarting QNet Wallet...');
            
            // Cleanup existing instances
            if (this.testnetIntegration) {
                this.testnetIntegration.destroy();
            }
            
            if (this.interface) {
                this.interface.destroy();
            }
            
            if (this.wallet) {
                // Don't destroy wallet data, just cleanup
                this.wallet.cleanup?.();
            }
            
            // Clear error state
            this.errorCount = 0;
            this.lastError = null;
            this.initialized = false;
            
            // Reinitialize
            await this.init();
            
        } catch (error) {
            console.error('Failed to restart application:', error);
            this.handleCriticalError(error);
        }
    }

    /**
     * Get application info
     */
    getInfo() {
        return {
            name: 'QNet Dual Wallet',
            version: '1.0.0',
            environment: this.config.getEnvironment(),
            initialized: this.initialized,
            uptime: Date.now() - this.startTime,
            features: [
                'Dual-network architecture (Solana + QNet)',
                'EON address system',
                'Cross-chain node activation',
                'Production-ready security',
                'Real-time bridge communication',
                'Node ownership management'
            ]
        };
    }
}

// Initialize application when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        window.QNetWallet = new QNetWalletApp();
    });
} else {
    window.QNetWallet = new QNetWalletApp();
}

// Export for module usage
export { QNetWalletApp }; 