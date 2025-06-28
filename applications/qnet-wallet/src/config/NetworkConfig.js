/**
 * Network Configuration for QNet Wallet
 * Production-ready configuration for testnet and mainnet environments
 */

export class NetworkConfig {
    constructor() {
        this.environment = this.detectEnvironment();
        this.networks = this.getNetworkConfigs();
    }

    /**
     * Detect current environment
     */
    detectEnvironment() {
        // Check for production environment indicators
        if (typeof window !== 'undefined') {
            const hostname = window.location?.hostname;
            if (hostname === 'wallet.qnet.network' || hostname === 'aiqnet.io') {
                return 'mainnet';
            }
            if (hostname === 'testnet.qnet.network' || hostname.includes('test')) {
                return 'testnet';
            }
        }

        // Check environment variables
        const env = process.env.NODE_ENV || 'development';
        if (env === 'production') {
            return 'mainnet';
        }

        return 'testnet'; // Default to testnet for development
    }

    /**
     * Get network configurations
     */
    getNetworkConfigs() {
        return {
            testnet: {
                solana: {
                    name: 'Solana Devnet',
                    rpc: 'https://api.devnet.solana.com',
                    wsRpc: 'wss://api.devnet.solana.com',
                    explorer: 'https://explorer.solana.com',
                    oneDevMint: '9GcdXAo2EyjNdNLuQoScSVbfJSnh9RdkSS8YYKnGQ8Pf',
                    burnAddress: 'BURN1111111111111111111111111111111111111111',
                    burnContract: 'QNETxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                    derivationPath: "m/44'/501'/0'/0'",
                    commitment: 'confirmed',
                    timeout: 30000
                },
                qnet: {
                    name: 'QNet Testnet',
                    rpc: 'https://testnet-rpc.qnet.network',
                    wsRpc: 'wss://testnet-rpc.qnet.network/ws',
                    explorer: 'https://testnet-explorer.qnet.network',
                    chainId: 'qnet-testnet-1',
                    qncDecimals: 9,
                    activationCosts: {
                        light: 2500,    // 50% discount for testnet
                        full: 3750,     // 50% discount for testnet
                        super: 5000     // 50% discount for testnet
                    },
                    networkSizeMultipliers: {
                        small: 0.25,    // 0-10K nodes (testnet discount)
                        medium: 0.5,    // 10K-100K nodes
                        large: 1.0,     // 100K+ nodes
                        massive: 1.5    // 1M+ nodes
                    },
                    timeout: 15000
                },
                bridge: {
                    name: 'QNet Testnet Bridge',
                    url: 'https://testnet-bridge.qnet.network',
                    wsUrl: 'wss://testnet-bridge.qnet.network/ws',
                    apiVersion: 'v1',
                    timeout: 30000,
                    retryAttempts: 3,
                    retryDelay: 2000
                }
            },
            mainnet: {
                solana: {
                    name: 'Solana Mainnet',
                    rpc: 'https://api.mainnet-beta.solana.com',
                    wsRpc: 'wss://api.mainnet-beta.solana.com',
                    explorer: 'https://explorer.solana.com',
                    oneDevMint: 'PROD1DEVxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                    burnAddress: 'BURNPROD111111111111111111111111111111111',
                    burnContract: 'QNETPRODxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                    derivationPath: "m/44'/501'/0'/0'",
                    commitment: 'finalized',
                    timeout: 60000
                },
                qnet: {
                    name: 'QNet Mainnet',
                    rpc: 'https://rpc.qnet.network',
                    wsRpc: 'wss://rpc.qnet.network/ws',
                    explorer: 'https://explorer.qnet.network',
                    chainId: 'qnet-mainnet-1',
                    qncDecimals: 9,
                    activationCosts: {
                        light: 5000,
                        full: 7500,
                        super: 10000
                    },
                    networkSizeMultipliers: {
                        small: 0.5,     // 0-100K nodes
                        medium: 1.0,    // 100K-1M nodes
                        large: 2.0,     // 1M-10M nodes
                        massive: 3.0    // 10M+ nodes
                    },
                    timeout: 30000
                },
                bridge: {
                    name: 'QNet Production Bridge',
                    url: 'https://bridge.qnet.network',
                    wsUrl: 'wss://bridge.qnet.network/ws',
                    apiVersion: 'v1',
                    timeout: 60000,
                    retryAttempts: 5,
                    retryDelay: 3000
                }
            }
        };
    }

    /**
     * Get current environment configuration
     */
    getCurrentConfig() {
        return this.networks[this.environment];
    }

    /**
     * Get Solana configuration
     */
    getSolanaConfig() {
        return this.getCurrentConfig().solana;
    }

    /**
     * Get QNet configuration
     */
    getQNetConfig() {
        return this.getCurrentConfig().qnet;
    }

    /**
     * Get Bridge configuration
     */
    getBridgeConfig() {
        return this.getCurrentConfig().bridge;
    }

    /**
     * Get activation costs with network size multiplier
     */
    getActivationCosts(networkSize = 1000) {
        const config = this.getQNetConfig();
        const baseCosts = config.activationCosts;
        const multipliers = config.networkSizeMultipliers;

        let multiplier;
        if (networkSize < 100000) {
            multiplier = multipliers.small;
        } else if (networkSize < 1000000) {
            multiplier = multipliers.medium;
        } else if (networkSize < 10000000) {
            multiplier = multipliers.large;
        } else {
            multiplier = multipliers.massive;
        }

        return {
            light: Math.floor(baseCosts.light * multiplier),
            full: Math.floor(baseCosts.full * multiplier),
            super: Math.floor(baseCosts.super * multiplier),
            multiplier,
            networkSize
        };
    }

    /**
     * Get network endpoints for health checking
     */
    getHealthCheckEndpoints() {
        const config = this.getCurrentConfig();
        return {
            solana: `${config.solana.rpc}/health`,
            qnet: `${config.qnet.rpc}/api/v1/health`,
            bridge: `${config.bridge.url}/api/v1/health`
        };
    }

    /**
     * Get WebSocket endpoints
     */
    getWebSocketEndpoints() {
        const config = this.getCurrentConfig();
        return {
            solana: config.solana.wsRpc,
            qnet: config.qnet.wsRpc,
            bridge: config.bridge.wsUrl
        };
    }

    /**
     * Get explorer URLs
     */
    getExplorerUrls() {
        const config = this.getCurrentConfig();
        return {
            solana: config.solana.explorer,
            qnet: config.qnet.explorer
        };
    }

    /**
     * Validate network configuration
     */
    validateConfig() {
        const config = this.getCurrentConfig();
        const errors = [];

        // Validate Solana config
        if (!config.solana.rpc.startsWith('https://')) {
            errors.push('Solana RPC must use HTTPS in production');
        }
        if (!config.solana.oneDevMint || config.solana.oneDevMint.length < 32) {
            errors.push('Invalid Solana 1DEV mint address');
        }

        // Validate QNet config
        if (!config.qnet.rpc.startsWith('https://')) {
            errors.push('QNet RPC must use HTTPS in production');
        }
        if (!config.qnet.chainId) {
            errors.push('QNet chain ID is required');
        }

        // Validate Bridge config
        if (!config.bridge.url.startsWith('https://')) {
            errors.push('Bridge URL must use HTTPS in production');
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }

    /**
     * Get retry configuration
     */
    getRetryConfig() {
        const config = this.getCurrentConfig();
        return {
            solana: {
                attempts: 3,
                delay: 1000,
                backoff: 2.0
            },
            qnet: {
                attempts: 3,
                delay: 1000,
                backoff: 2.0
            },
            bridge: {
                attempts: config.bridge.retryAttempts,
                delay: config.bridge.retryDelay,
                backoff: 1.5
            }
        };
    }

    /**
     * Get timeout configuration
     */
    getTimeoutConfig() {
        const config = this.getCurrentConfig();
        return {
            solana: config.solana.timeout,
            qnet: config.qnet.timeout,
            bridge: config.bridge.timeout
        };
    }

    /**
     * Switch environment (for testing)
     */
    switchEnvironment(environment) {
        if (!this.networks[environment]) {
            throw new Error(`Unknown environment: ${environment}`);
        }
        this.environment = environment;
    }

    /**
     * Get current environment
     */
    getEnvironment() {
        return this.environment;
    }

    /**
     * Check if running in production
     */
    isProduction() {
        return this.environment === 'mainnet';
    }

    /**
     * Check if running in testnet
     */
    isTestnet() {
        return this.environment === 'testnet';
    }

    /**
     * Get security configuration
     */
    getSecurityConfig() {
        return {
            requireHttps: this.isProduction(),
            validateCertificates: this.isProduction(),
            enableCSP: true,
            maxRetries: this.isProduction() ? 5 : 3,
            timeout: this.isProduction() ? 60000 : 30000
        };
    }

    /**
     * Get feature flags
     */
    getFeatureFlags() {
        return {
            enableDebugLogging: !this.isProduction(),
            enableMetrics: true,
            enableWebSockets: true,
            enableCaching: true,
            enableRetries: true,
            strictValidation: this.isProduction()
        };
    }
} 