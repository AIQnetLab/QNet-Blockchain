/**
 * Network Configuration for QNet Wallet
 * Production-ready configuration for testnet and mainnet environments
 */

export class NetworkConfig {
    constructor() {
        this.environment = this.detectEnvironment();
        this.networks = this.getNetworkConfigs();
        this.currentSolanaNetwork = 'devnet'; // Default to devnet for safety
        this.currentQNetNetwork = 'testnet'; // Default to testnet
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
                    devnet: {
                        name: 'Solana Devnet',
                        rpc: 'https://api.devnet.solana.com',
                        wsRpc: 'wss://api.devnet.solana.com',
                        explorer: 'https://explorer.solana.com',
                        oneDevMint: 'Wkg19zERBsBiyqsh2ffcUrFG4eL5BF5BWkg19zERBsBi',
                        burnAddress: 'BURN1111111111111111111111111111111111111111',
                        burnContract: 'QNETxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                        derivationPath: "m/44'/501'/0'/0'",
                        commitment: 'confirmed',
                        timeout: 30000,
                        networkId: 'devnet'
                    },
                    mainnet: {
                        name: 'Solana Mainnet Beta',
                        rpc: 'https://api.mainnet-beta.solana.com',
                        wsRpc: 'wss://api.mainnet-beta.solana.com',
                        explorer: 'https://explorer.solana.com',
                        oneDevMint: 'PROD1DEVxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                        burnAddress: 'BURNPROD111111111111111111111111111111111',
                        burnContract: 'QNETPRODxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                        derivationPath: "m/44'/501'/0'/0'",
                        commitment: 'finalized',
                        timeout: 60000,
                        networkId: 'mainnet-beta'
                    }
                },
                qnet: {
                    testnet: {
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
                        timeout: 15000,
                        networkId: 'testnet'
                    },
                    mainnet: {
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
                        timeout: 30000,
                        networkId: 'mainnet'
                    }
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
                    devnet: {
                        name: 'Solana Devnet',
                        rpc: 'https://api.devnet.solana.com',
                        wsRpc: 'wss://api.devnet.solana.com',
                        explorer: 'https://explorer.solana.com',
                        oneDevMint: '9GcdXAo2EyjNdNLuQoScSVbfJSnh9RdkSS8YYKnGQ8Pf',
                        burnAddress: 'BURN1111111111111111111111111111111111111111',
                        burnContract: 'QNETxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                        derivationPath: "m/44'/501'/0'/0'",
                        commitment: 'confirmed',
                        timeout: 30000,
                        networkId: 'devnet'
                    },
                    mainnet: {
                        name: 'Solana Mainnet Beta',
                        rpc: 'https://api.mainnet-beta.solana.com',
                        wsRpc: 'wss://api.mainnet-beta.solana.com',
                        explorer: 'https://explorer.solana.com',
                        oneDevMint: 'PROD1DEVxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                        burnAddress: 'BURNPROD111111111111111111111111111111111',
                        burnContract: 'QNETPRODxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                        derivationPath: "m/44'/501'/0'/0'",
                        commitment: 'finalized',
                        timeout: 60000,
                        networkId: 'mainnet-beta'
                    }
                },
                qnet: {
                    testnet: {
                        name: 'QNet Testnet',
                        rpc: 'https://testnet-rpc.qnet.network',
                        wsRpc: 'wss://testnet-rpc.qnet.network/ws',
                        explorer: 'https://testnet-explorer.qnet.network',
                        chainId: 'qnet-testnet-1',
                        qncDecimals: 9,
                        activationCosts: {
                            light: 2500,
                            full: 3750,
                            super: 5000
                        },
                        networkSizeMultipliers: {
                            small: 0.25,
                            medium: 0.5,
                            large: 1.0,
                            massive: 1.5
                        },
                        timeout: 15000,
                        networkId: 'testnet'
                    },
                    mainnet: {
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
                        timeout: 30000,
                        networkId: 'mainnet'
                    }
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
     * Get Solana configuration for current network
     */
    getSolanaConfig() {
        const config = this.getCurrentConfig();
        return config.solana[this.currentSolanaNetwork];
    }

    /**
     * Get QNet configuration for current network
     */
    getQNetConfig() {
        const config = this.getCurrentConfig();
        return config.qnet[this.currentQNetNetwork];
    }

    /**
     * Get Bridge configuration
     */
    getBridgeConfig() {
        return this.getCurrentConfig().bridge;
    }

    /**
     * Switch Solana network
     */
    switchSolanaNetwork(network) {
        if (!this.networks[this.environment].solana[network]) {
            throw new Error(`Unknown Solana network: ${network}`);
        }
        this.currentSolanaNetwork = network;
        return this.getSolanaConfig();
    }

    /**
     * Switch QNet network
     */
    switchQNetNetwork(network) {
        if (!this.networks[this.environment].qnet[network]) {
            throw new Error(`Unknown QNet network: ${network}`);
        }
        this.currentQNetNetwork = network;
        return this.getQNetConfig();
    }

    /**
     * Get all available network options
     */
    getAvailableNetworks() {
        return {
            solana: Object.keys(this.networks[this.environment].solana),
            qnet: Object.keys(this.networks[this.environment].qnet)
        };
    }

    /**
     * Get current network states
     */
    getCurrentNetworkStates() {
        return {
            solana: this.currentSolanaNetwork,
            qnet: this.currentQNetNetwork,
            environment: this.environment
        };
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
        return {
            solana: `${this.getSolanaConfig().rpc}/health`,
            qnet: `${this.getQNetConfig().rpc}/api/v1/health`,
            bridge: `${this.getBridgeConfig().url}/api/v1/health`
        };
    }

    /**
     * Get WebSocket endpoints
     */
    getWebSocketEndpoints() {
        return {
            solana: this.getSolanaConfig().wsRpc,
            qnet: this.getQNetConfig().wsRpc,
            bridge: this.getBridgeConfig().wsUrl
        };
    }

    /**
     * Get explorer URLs
     */
    getExplorerUrls() {
        return {
            solana: this.getSolanaConfig().explorer,
            qnet: this.getQNetConfig().explorer
        };
    }

    /**
     * Validate network configuration
     */
    validateConfig() {
        const solanaConfig = this.getSolanaConfig();
        const qnetConfig = this.getQNetConfig();
        const bridgeConfig = this.getBridgeConfig();
        const errors = [];

        // Validate Solana config
        if (!solanaConfig.rpc.startsWith('https://')) {
            errors.push('Solana RPC must use HTTPS in production');
        }
        if (!solanaConfig.oneDevMint || solanaConfig.oneDevMint.length < 32) {
            errors.push('Invalid Solana 1DEV mint address');
        }

        // Validate QNet config
        if (!qnetConfig.rpc.startsWith('https://')) {
            errors.push('QNet RPC must use HTTPS in production');
        }
        if (!qnetConfig.chainId) {
            errors.push('QNet chain ID is required');
        }

        // Validate Bridge config
        if (!bridgeConfig.url.startsWith('https://')) {
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
                attempts: this.getBridgeConfig().retryAttempts,
                delay: this.getBridgeConfig().retryDelay,
                backoff: 1.5
            }
        };
    }

    /**
     * Get timeout configuration
     */
    getTimeoutConfig() {
        return {
            solana: this.getSolanaConfig().timeout,
            qnet: this.getQNetConfig().timeout,
            bridge: this.getBridgeConfig().timeout
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