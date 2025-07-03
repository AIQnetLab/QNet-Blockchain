/**
 * Production Fee Configuration for QNet Wallet
 * All fees are collected for platform maintenance and development
 */

export const PRODUCTION_FEES = {
    // Swap fees
    swap: 0.005, // 0.5% on token swaps
    bridge: 0.005, // 0.5% on cross-chain bridge operations
    
    // Free operations
    activation: 0, // QNC Pool 3 activation is free
    transfer: 0, // Regular transfers are free (only network fees)
    
    // Minimum amounts (no limits)
    minimumSwap: 0,
    minimumBridge: 0
};

export const FEE_RECIPIENTS = {
    // Production addresses for fee collection
    solana: "E3qKpwaLAJvx2aVopWikeBBQiYQzyG1McBcobwT4t7g",
    qnet: null, // Will be set when QNet network launches
    
    // Backup addresses (to be set if needed)
    backup: {
        solana: null,
        qnet: null
    }
};

export const SUPPORTED_TOKENS = {
    solana: {
        // Native Solana tokens
        native: {
            SOL: {
                symbol: "SOL",
                name: "Solana",
                decimals: 9,
                mintAddress: "So11111111111111111111111111111111111111112",
                logoURI: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png"
            }
        },
        
        // Popular SPL tokens
        spl: {
            USDC: {
                symbol: "USDC",
                name: "USD Coin",
                decimals: 6,
                mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                logoURI: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png"
            },
            USDT: {
                symbol: "USDT",
                name: "Tether USD",
                decimals: 6,
                mintAddress: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
                logoURI: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.svg"
            },
            "1DEV": {
                symbol: "1DEV",
                name: "1DEV Token",
                decimals: 9,
                mintAddress: "1DEVbPWX3Wo39EKfcUeMcEE1aRKe8CnTEWdH7kW5CrT",
                logoURI: "/icons/1dev-token.png"
            }
        },
        
        // User-added custom tokens
        custom: {}
    },
    
    qnet: {
        // Native QNet tokens
        native: {
            QNC: {
                symbol: "QNC",
                name: "QNet Coin",
                decimals: 18,
                address: "qnet_native_qnc",
                logoURI: "/icons/qnc-token.png"
            }
        },
        
        // QNet ecosystem tokens
        ecosystem: {
            // Will be populated as QNet ecosystem grows
        },
        
        // User-added custom tokens
        custom: {}
    }
};

/**
 * Calculate swap fee for given amount
 * @param {number} amount - Amount to swap
 * @param {string} network - Network (solana/qnet)
 * @returns {number} Fee amount
 */
export function calculateSwapFee(amount, network = 'solana') {
    if (!amount || amount <= 0) return 0;
    return amount * PRODUCTION_FEES.swap;
}

/**
 * Calculate bridge fee for cross-chain operations
 * @param {number} amount - Amount to bridge
 * @returns {number} Fee amount
 */
export function calculateBridgeFee(amount) {
    if (!amount || amount <= 0) return 0;
    return amount * PRODUCTION_FEES.bridge;
}

/**
 * Get fee recipient address for network
 * @param {string} network - Network (solana/qnet)
 * @returns {string|null} Recipient address
 */
export function getFeeRecipient(network) {
    return FEE_RECIPIENTS[network] || FEE_RECIPIENTS.backup[network];
}

/**
 * Add custom token to supported tokens list
 * @param {string} network - Network (solana/qnet)
 * @param {object} tokenData - Token information
 */
export function addCustomToken(network, tokenData) {
    if (!SUPPORTED_TOKENS[network]) return false;
    
    const tokenId = tokenData.symbol.toUpperCase();
    SUPPORTED_TOKENS[network].custom[tokenId] = {
        ...tokenData,
        isCustom: true,
        addedAt: Date.now()
    };
    
    // Save to localStorage for persistence
    const customTokens = JSON.parse(localStorage.getItem('qnet_custom_tokens') || '{}');
    if (!customTokens[network]) customTokens[network] = {};
    customTokens[network][tokenId] = SUPPORTED_TOKENS[network].custom[tokenId];
    localStorage.setItem('qnet_custom_tokens', JSON.stringify(customTokens));
    
    return true;
}

/**
 * Load custom tokens from localStorage
 */
export function loadCustomTokens() {
    try {
        const customTokens = JSON.parse(localStorage.getItem('qnet_custom_tokens') || '{}');
        
        Object.keys(customTokens).forEach(network => {
            if (SUPPORTED_TOKENS[network]) {
                SUPPORTED_TOKENS[network].custom = {
                    ...SUPPORTED_TOKENS[network].custom,
                    ...customTokens[network]
                };
            }
        });
    } catch (error) {
        console.error('Failed to load custom tokens:', error);
    }
}

/**
 * Get all tokens for a network
 * @param {string} network - Network (solana/qnet)
 * @returns {object} All tokens for the network
 */
export function getAllTokens(network) {
    if (!SUPPORTED_TOKENS[network]) return {};
    
    return {
        ...SUPPORTED_TOKENS[network].native,
        ...SUPPORTED_TOKENS[network].spl,
        ...SUPPORTED_TOKENS[network].ecosystem,
        ...SUPPORTED_TOKENS[network].custom
    };
}

// Load custom tokens on module initialization
loadCustomTokens();

console.log('✅ Production fee configuration loaded'); 