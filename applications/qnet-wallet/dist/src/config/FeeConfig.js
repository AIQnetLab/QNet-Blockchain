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
                decimals: 6,
                mintAddress: "Wkg19zERBsBiyqsh2ffcUrFG4eL5BF5BWkg19zERBsBi",
                logoURI: "data:image/webp;base64,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"
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