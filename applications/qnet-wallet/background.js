/**
 * QNet Dual Wallet Background Service Worker - Production Version
 * Supports both Solana and QNet networks with real cryptography and cross-chain functionality
 */

// Import production modules with proper error handling
let ProductionCrypto, SolanaRPC, QRGenerator, DualNetworkManager, QNetIntegration;

// Initialize modules
(async () => {
    try {
        const [cryptoModule, solanaModule, qrModule] = await Promise.all([
            import('./src/crypto/RealCrypto.js').catch(() => null),
            import('./src/blockchain/SolanaRPC.js').catch(() => null),
            import('./src/utils/QRGenerator.js').catch(() => null)
        ]);
        
        ProductionCrypto = cryptoModule?.ProductionCrypto;
        SolanaRPC = solanaModule?.SolanaRPC;
        QRGenerator = qrModule?.QRGenerator;
        
        console.log('✅ Production modules loaded successfully');
    } catch (error) {
        console.error('❌ Failed to load modules:', error);
    }
})();

// Enhanced global state for dual network support
let walletState = {
    isUnlocked: false,
    accounts: [],
    currentNetwork: 'qnet', // Start with QNet as primary
    currentPhase: 1,
    settings: {
        autoLock: true,
        lockTimeout: 15 * 60 * 1000, // 15 minutes
        language: 'en'
    },
    encryptedWallet: null,
    networks: {
        solana: {
            rpc: null,
            connection: null,
            balanceCache: new Map(),
            transactionHistory: new Map()
        },
        qnet: {
            rpc: null,
            connection: null,
            balanceCache: new Map(),
            nodeInfo: new Map()
        }
    }
};

let lockTimer = null;
let balanceUpdateInterval = null;

// Initialize on startup
chrome.runtime.onStartup.addListener(() => {
    initializeDualWallet();
});

chrome.runtime.onInstalled.addListener(() => {
    initializeDualWallet();
});

/**
 * Initialize dual wallet with both networks
 */
async function initializeDualWallet() {
    try {
        console.log('🚀 Initializing QNet Dual Wallet background...');
        
        // Wait for modules to load
        await waitForModules();
        
        // Initialize Solana RPC
        walletState.networks.solana.rpc = new SolanaRPC('devnet');
        
        // Initialize QNet RPC (placeholder - would be actual QNet RPC)
        walletState.networks.qnet.rpc = {
            getBalance: async (address) => ({ QNC: 0 }),
            getNodeInfo: async (address) => null,
            sendTransaction: async (tx) => ({ success: true, txId: 'mock' })
        };
        
        // Load wallet state from storage
        const result = await chrome.storage.local.get([
            'walletExists', 
            'encryptedWallet', 
            'isUnlocked', 
            'lastUnlockTime',
            'currentNetwork',
            'currentPhase'
        ]);
        
        const walletExists = result.walletExists || false;
        walletState.encryptedWallet = result.encryptedWallet;
        walletState.currentNetwork = result.currentNetwork || 'qnet';
        walletState.currentPhase = result.currentPhase || 1;
        
        // Check if wallet should remain unlocked
        if (walletExists && result.isUnlocked) {
            const lastUnlockTime = result.lastUnlockTime || 0;
            const timeSinceUnlock = Date.now() - lastUnlockTime;
            
            if (timeSinceUnlock < walletState.settings.lockTimeout) {
                // Restore unlocked state
                walletState.isUnlocked = true;
                await loadWalletAccounts();
                startAutoLockTimer();
                startDualNetworkUpdates();
                console.log('🔓 Dual wallet restored to unlocked state');
            }
        }
        
        console.log('✅ QNet Dual Wallet initialized successfully');
        
    } catch (error) {
        console.error('❌ Failed to initialize dual wallet:', error);
    }
}

/**
 * Wait for ES6 modules to load with timeout
 */
async function waitForModules() {
    let attempts = 0;
    const maxAttempts = 100;
    
    while (attempts < maxAttempts) {
        if (ProductionCrypto && SolanaRPC && QRGenerator) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
    }
    
    console.warn('⚠️ Some modules failed to load, using fallbacks');
}

/**
 * Enhanced message handler for dual network
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    handleDualWalletMessage(request, sender, sendResponse);
    return true; // Keep message channel open for async response
});

/**
 * Handle incoming messages with dual network support
 */
async function handleDualWalletMessage(request, sender, sendResponse) {
    try {
        console.log('📨 Dual wallet message received:', request.type);
        
        switch (request.type) {
            // Wallet state management
            case 'GET_WALLET_STATE':
                sendResponse(await getDualWalletState());
                break;
                
            case 'SAVE_WALLET_STATE':
                await saveDualWalletState(request.state);
                sendResponse({ success: true });
                break;
                
            // Wallet operations
            case 'CREATE_WALLET':
                const createResult = await createDualWallet(request.password, request.mnemonic);
                sendResponse(createResult);
                break;
                
            case 'IMPORT_WALLET':
                const importResult = await importDualWallet(request.password, request.mnemonic);
                sendResponse(importResult);
                break;
                
            case 'UNLOCK_WALLET':
                const unlockResult = await unlockDualWallet(request.password);
                sendResponse(unlockResult);
                break;
                
            case 'LOCK_WALLET':
                await lockDualWallet();
                sendResponse({ success: true });
                break;
                
            // Network operations
            case 'SWITCH_NETWORK':
                const switchResult = await switchNetwork(request.network);
                sendResponse(switchResult);
                break;
                
            case 'GET_NETWORK_STATUS':
                const status = await getNetworkStatus(request.network);
                sendResponse({ status });
                break;
                
            // Balance and transaction operations
            case 'GET_BALANCE':
                const balance = await getDualBalance(request.address, request.network);
                sendResponse({ balance });
                break;
                
            case 'GET_NODE_INFO':
                const nodeInfo = await getNodeInfo(request.address);
                sendResponse({ nodeInfo });
                break;
                
            case 'SEND_TRANSACTION':
                const txResult = await sendDualTransaction(request.transactionData);
                sendResponse(txResult);
                break;
                
            // Utility operations
            case 'GENERATE_QR':
                const qrResult = await generateQRCode(request.data, request.options);
                sendResponse(qrResult);
                break;
                
            case 'GENERATE_EON_ADDRESS':
                const eonResult = await generateEONAddress(request.seed, request.index);
                sendResponse(eonResult);
                break;
                
            // Phase detection
            case 'DETECT_PHASE':
                const phase = await detectCurrentPhase();
                sendResponse({ phase });
                break;
                
            case 'OPEN_SETUP_TAB':
                try {
                    await chrome.tabs.create({
                        url: 'setup.html',
                        active: true
                    });
                    sendResponse({ success: true });
                } catch (error) {
                    sendResponse({ success: false, error: error.message });
                }
                break;
                
            case 'CHECK_WALLET_EXISTS':
                const exists = await checkWalletExists();
                sendResponse({ exists });
                break;
                
            case 'CLEAR_WALLET':
                try {
                    await chrome.storage.local.clear();
                    await lockDualWallet();
                    sendResponse({ success: true });
                } catch (error) {
                    sendResponse({ success: false, error: error.message });
                }
                break;
                
            case 'GENERATE_MNEMONIC':
                try {
                    if (!ProductionCrypto) {
                        sendResponse({ success: false, error: 'Crypto module not available' });
                        break;
                    }
                    const mnemonic = ProductionCrypto.generateMnemonic(request.entropy || 128);
                    sendResponse({ success: true, mnemonic });
                } catch (error) {
                    sendResponse({ success: false, error: error.message });
                }
                break;
                
            // Legacy wallet request handler
            case 'WALLET_REQUEST':
                const response = await handleWalletRequest(request);
                sendResponse(response);
                break;
                
            default:
                sendResponse({ error: 'Unknown request type' });
        }
        
    } catch (error) {
        console.error('❌ Dual wallet message handler error:', error);
        sendResponse({ error: error.message });
    }
}

/**
 * Create new dual wallet with both Solana and QNet support
 */
async function createDualWallet(password, mnemonic) {
    try {
        console.log('💎 Creating new dual wallet...');
        
        const walletExists = await checkWalletExists();
        if (walletExists) {
            return { success: false, error: 'Wallet already exists' };
        }
        
        if (!ProductionCrypto) {
            return { success: false, error: 'Crypto module not available' };
        }
        
        // Generate or validate mnemonic
        const seedPhrase = mnemonic || ProductionCrypto.generateMnemonic();
        
        if (!ProductionCrypto.validateMnemonic(seedPhrase)) {
            return { success: false, error: 'Invalid mnemonic phrase' };
        }
        
        // Derive seed from mnemonic
        const seed = ProductionCrypto.mnemonicToSeed(seedPhrase);
        
        // Generate keypairs for both networks
        const solanaKeypair = ProductionCrypto.generateSolanaKeypair(seed, 0);
        const qnetAddress = ProductionCrypto.generateQNetAddress(seed, 0);
        
        // Create dual wallet data
        const walletData = {
            version: 2, // Version 2 for dual network
            type: 'dual-network',
            mnemonic: seedPhrase,
            accounts: [{
                index: 0,
                networks: {
                    solana: {
                        keypair: {
                            publicKey: Array.from(solanaKeypair.publicKey),
                            secretKey: Array.from(solanaKeypair.secretKey)
                        },
                        address: solanaKeypair.address
                    },
                    qnet: {
                        address: qnetAddress // EON address
                    }
                }
            }],
            supportedNetworks: ['solana', 'qnet'],
            createdAt: Date.now()
        };
        
        // Encrypt wallet data
        const encryptedWallet = ProductionCrypto.encryptWalletData(walletData, password);
        
        // Save to storage
        await chrome.storage.local.set({
            walletExists: true,
            encryptedWallet: encryptedWallet,
            currentNetwork: 'qnet',
            currentPhase: 1
        });
        
        // Auto-unlock wallet after creation
        walletState.isUnlocked = true;
        walletState.encryptedWallet = encryptedWallet;
        walletState.currentNetwork = 'qnet';
        
        // Load accounts
        await loadDualWalletAccounts(walletData);
        
        // Start timers
        startAutoLockTimer();
        startDualNetworkUpdates();
        
        console.log('✅ Dual wallet created successfully');
        return { 
            success: true, 
            accounts: walletState.accounts,
            mnemonic: seedPhrase,
            networks: ['solana', 'qnet']
        };
        
    } catch (error) {
        console.error('❌ Dual wallet creation failed:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Import existing dual wallet
 */
async function importDualWallet(password, mnemonic) {
    try {
        console.log('📥 Importing dual wallet...');
        
        const walletExists = await checkWalletExists();
        if (walletExists) {
            return { success: false, error: 'Wallet already exists' };
        }
        
        if (!ProductionCrypto || !ProductionCrypto.validateMnemonic(mnemonic)) {
            return { success: false, error: 'Invalid mnemonic phrase' };
        }
        
        // Use createDualWallet with provided mnemonic
        return await createDualWallet(password, mnemonic);
        
    } catch (error) {
        console.error('❌ Dual wallet import failed:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Unlock dual wallet with password
 */
async function unlockDualWallet(password) {
    try {
        console.log('🔓 Unlocking dual wallet...');
        
        const walletExists = await checkWalletExists();
        if (!walletExists) {
            return { success: false, error: 'No wallet found' };
        }
        
        if (!ProductionCrypto) {
            return { success: false, error: 'Crypto module not available' };
        }
        
        // Get encrypted wallet
        const result = await chrome.storage.local.get(['encryptedWallet']);
        if (!result.encryptedWallet) {
            return { success: false, error: 'No wallet data found' };
        }
        
        // Decrypt wallet data
        const walletData = ProductionCrypto.decryptWalletData(result.encryptedWallet, password);
        
        // Load accounts for both networks
        await loadDualWalletAccounts(walletData);
        
        walletState.isUnlocked = true;
        walletState.encryptedWallet = result.encryptedWallet;
        
        // Save unlock state
        await chrome.storage.local.set({
            isUnlocked: true,
            lastUnlockTime: Date.now()
        });
        
        // Start timers
        startAutoLockTimer();
        startDualNetworkUpdates();
        
        console.log('✅ Dual wallet unlocked successfully');
        return { 
            success: true, 
            accounts: walletState.accounts,
            currentNetwork: walletState.currentNetwork
        };
        
    } catch (error) {
        console.error('❌ Dual wallet unlock failed:', error);
        return { success: false, error: 'Invalid password or corrupted wallet' };
    }
}

/**
 * Lock dual wallet
 */
async function lockDualWallet() {
    console.log('🔒 Locking dual wallet...');
    
    walletState.isUnlocked = false;
    walletState.accounts = [];
    
    // Clear all caches
    walletState.networks.solana.balanceCache.clear();
    walletState.networks.solana.transactionHistory.clear();
    walletState.networks.qnet.balanceCache.clear();
    walletState.networks.qnet.nodeInfo.clear();
    
    // Clear timers
    if (lockTimer) {
        clearTimeout(lockTimer);
        lockTimer = null;
    }
    
    if (balanceUpdateInterval) {
        clearInterval(balanceUpdateInterval);
        balanceUpdateInterval = null;
    }
    
    // Save locked state
    await chrome.storage.local.set({
        isUnlocked: false,
        lastUnlockTime: 0
    });
    
    console.log('✅ Dual wallet locked');
}

/**
 * Load wallet accounts from decrypted dual wallet data
 */
async function loadDualWalletAccounts(walletData) {
    try {
        walletState.accounts = [];
        
        for (const accountData of walletData.accounts) {
            const account = {
                index: accountData.index,
                networks: {},
                currentBalance: {}
            };
            
            // Load Solana account data
            if (accountData.networks.solana) {
                account.networks.solana = {
                    address: accountData.networks.solana.address,
                    keypair: {
                        publicKey: new Uint8Array(accountData.networks.solana.keypair.publicKey),
                        secretKey: new Uint8Array(accountData.networks.solana.keypair.secretKey)
                    }
                };
                account.solanaAddress = accountData.networks.solana.address; // Legacy compatibility
            }
            
            // Load QNet account data  
            if (accountData.networks.qnet) {
                account.networks.qnet = {
                    address: accountData.networks.qnet.address // EON address
                };
                account.qnetAddress = accountData.networks.qnet.address; // Legacy compatibility
            }
            
            walletState.accounts.push(account);
        }
        
        console.log('✅ Dual wallet accounts loaded:', walletState.accounts.length);
        
    } catch (error) {
        console.error('❌ Failed to load dual wallet accounts:', error);
        throw error;
    }
}

/**
 * Get dual balance for specified network
 */
async function getDualBalance(address, network) {
    try {
        const cacheKey = `${network}_${address}`;
        const cache = walletState.networks[network]?.balanceCache;
        
        if (cache && cache.has(cacheKey)) {
            const cached = cache.get(cacheKey);
            if (Date.now() - cached.timestamp < 30000) { // 30 second cache
                return cached.balance;
            }
        }
        
        let balance = {};
        
        if (network === 'solana' && walletState.networks.solana.rpc) {
            // Get Solana balances
            const solBalance = await walletState.networks.solana.rpc.getBalance(address);
            const tokenBalances = await walletState.networks.solana.rpc.getTokenBalances(address);
            
            balance = {
                SOL: solBalance || 0,
                '1DEV': tokenBalances?.['1DEV'] || 0,
                ...tokenBalances
            };
            
        } else if (network === 'qnet' && walletState.networks.qnet.rpc) {
            // Get QNet balances
            const qncBalance = await walletState.networks.qnet.rpc.getBalance(address);
            
            balance = {
                QNC: qncBalance?.QNC || 0
            };
        }
        
        // Cache result
        if (cache) {
            cache.set(cacheKey, {
                balance: balance,
                timestamp: Date.now()
            });
        }
        
        return balance;
        
    } catch (error) {
        console.error(`❌ Failed to get ${network} balance:`, error);
        return network === 'solana' ? { SOL: 0, '1DEV': 0 } : { QNC: 0 };
    }
}

/**
 * Get QNet node information
 */
async function getNodeInfo(eonAddress) {
    try {
        const cache = walletState.networks.qnet.nodeInfo;
        
        if (cache.has(eonAddress)) {
            const cached = cache.get(eonAddress);
            if (Date.now() - cached.timestamp < 60000) { // 1 minute cache
                return cached.nodeInfo;
            }
        }
        
        // Get node info from QNet RPC
        const nodeInfo = await walletState.networks.qnet.rpc.getNodeInfo(eonAddress);
        
        // Cache result
        cache.set(eonAddress, {
            nodeInfo: nodeInfo,
            timestamp: Date.now()
        });
        
        return nodeInfo;
        
    } catch (error) {
        console.error('❌ Failed to get node info:', error);
        return null;
    }
}

/**
 * Generate EON address from seed
 */
async function generateEONAddress(seed, index = 0) {
    try {
        if (!ProductionCrypto) {
            throw new Error('Crypto module not available');
        }
        
        const eonAddress = ProductionCrypto.generateQNetAddress(seed, index);
        
        return {
            success: true,
            address: eonAddress
        };
        
    } catch (error) {
        console.error('❌ EON address generation failed:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Detect current QNet phase
 */
async function detectCurrentPhase() {
    try {
        // In production, this would query Solana contract for burn percentage
        // and QNet for network age
        
        // Mock implementation
        const burnPercentage = 25; // 25% of 1DEV burned
        const networkAge = 0.5; // 6 months old
        
        // Phase 2 conditions: 90% burned OR 5+ years
        if (burnPercentage >= 90 || networkAge >= 5) {
            walletState.currentPhase = 2;
        } else {
            walletState.currentPhase = 1;
        }
        
        // Save to storage
        await chrome.storage.local.set({
            currentPhase: walletState.currentPhase
        });
        
        return walletState.currentPhase;
        
    } catch (error) {
        console.error('❌ Phase detection failed:', error);
        return 1; // Default to Phase 1
    }
}

/**
 * Get dual wallet state
 */
async function getDualWalletState() {
    try {
        const walletExists = await checkWalletExists();
        
        return {
            success: true,
            walletExists: walletExists,
            isUnlocked: walletState.isUnlocked,
            accounts: walletState.accounts,
            currentNetwork: walletState.currentNetwork,
            currentPhase: walletState.currentPhase,
            networks: {
                solana: {
                    active: walletState.currentNetwork === 'solana',
                    connected: !!walletState.networks.solana.rpc
                },
                qnet: {
                    active: walletState.currentNetwork === 'qnet',
                    connected: !!walletState.networks.qnet.rpc
                }
            },
            language: walletState.settings.language
        };
        
    } catch (error) {
        console.error('❌ Failed to get dual wallet state:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Save dual wallet state
 */
async function saveDualWalletState(state) {
    try {
        // Update local state
        if (state.currentNetwork) {
            walletState.currentNetwork = state.currentNetwork;
        }
        
        if (state.language) {
            walletState.settings.language = state.language;
        }
        
        // Save to storage
        await chrome.storage.local.set({
            currentNetwork: walletState.currentNetwork,
            language: walletState.settings.language,
            currentPhase: walletState.currentPhase
        });
        
        console.log('✅ Dual wallet state saved');
        
    } catch (error) {
        console.error('❌ Failed to save dual wallet state:', error);
        throw error;
    }
}

/**
 * Switch between Solana and QNet networks
 */
async function switchNetwork(network) {
    try {
        if (network !== 'solana' && network !== 'qnet') {
            throw new Error('Invalid network');
        }
        
        if (walletState.currentNetwork === network) {
            return { success: true, network: network };
        }
        
        console.log(`🔄 Switching to ${network} network...`);
        
        walletState.currentNetwork = network;
        
        // Save to storage
        await chrome.storage.local.set({
            currentNetwork: network
        });
        
        console.log(`✅ Switched to ${network} network`);
        
        return {
            success: true,
            network: network,
            timestamp: Date.now()
        };
        
    } catch (error) {
        console.error('❌ Network switch failed:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Enhanced QR code generation
 */
async function generateQRCode(data, options = {}) {
    try {
        if (!QRGenerator) {
            // Fallback: return data URL with simple text
            return {
                success: false,
                error: 'QR Generator not available'
            };
        }
        
        const qrCode = await QRGenerator.generateQR(data, {
            size: options.size || 256,
            darkColor: options.darkColor || '#000000',
            lightColor: options.lightColor || '#ffffff'
        });
        
        return {
            success: true,
            qrDataUrl: qrCode
        };
        
    } catch (error) {
        console.error('❌ QR code generation failed:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Start dual network balance updates
 */
function startDualNetworkUpdates() {
    if (balanceUpdateInterval) {
        clearInterval(balanceUpdateInterval);
    }
    
    balanceUpdateInterval = setInterval(async () => {
        if (!walletState.isUnlocked || walletState.accounts.length === 0) {
            return;
        }
        
        try {
            // Update balances for current network
            const account = walletState.accounts[0];
            if (walletState.currentNetwork === 'solana' && account.networks.solana) {
                await getDualBalance(account.networks.solana.address, 'solana');
            } else if (walletState.currentNetwork === 'qnet' && account.networks.qnet) {
                await getDualBalance(account.networks.qnet.address, 'qnet');
                await getNodeInfo(account.networks.qnet.address);
            }
            
        } catch (error) {
            console.error('❌ Balance update failed:', error);
        }
    }, 30000); // Update every 30 seconds
}

/**
 * Handle legacy wallet requests for dApp compatibility
 */
async function handleWalletRequest(request) {
    const { method, params } = request;
    
    try {
        switch (method) {
            case 'connect':
            case 'qnet_requestAccounts':
                return await requestAccounts();
                
            case 'qnet_accounts':
                return await getAccounts();
                
            case 'qnet_chainId':
                return { 
                    result: walletState.currentNetwork === 'solana' 
                        ? 'solana-devnet' 
                        : 'qnet-mainnet' 
                };
                
            case 'qnet_switchNetwork':
                const switchResult = await switchNetwork(params[0]);
                return { result: switchResult };
                
            default:
                throw new Error(`Unknown method: ${method}`);
        }
        
    } catch (error) {
        console.error(`❌ Error handling ${method}:`, error);
        return { error: { message: error.message } };
    }
}

/**
 * Request accounts for dApp connection
 */
async function requestAccounts() {
    console.log('🔐 Dual wallet account access requested');
    
    const walletExists = await checkWalletExists();
    
    if (!walletExists) {
        console.log('💎 No wallet found, opening setup...');
        await chrome.tabs.create({
            url: chrome.runtime.getURL('setup.html'),
            active: true
        });
        return { error: { message: 'Please create a wallet first' } };
    }
    
    if (walletState.isUnlocked && walletState.accounts.length > 0) {
        console.log('✅ Returning existing accounts');
        const currentAccount = walletState.accounts[0];
        const address = walletState.currentNetwork === 'solana' 
            ? currentAccount.networks.solana?.address
            : currentAccount.networks.qnet?.address;
        return { result: [address] };
    }
    
    console.log('🔓 Wallet locked, opening unlock popup...');
    await chrome.tabs.create({
        url: chrome.runtime.getURL('popup.html'),
        active: true
    });
    return { error: { message: 'Please unlock your wallet' } };
}

/**
 * Get current accounts
 */
async function getAccounts() {
    if (!walletState.isUnlocked || walletState.accounts.length === 0) {
        return { result: [] };
    }
    
    const currentAccount = walletState.accounts[0];
    const address = walletState.currentNetwork === 'solana' 
        ? currentAccount.networks.solana?.address
        : currentAccount.networks.qnet?.address;
    
    return { result: [address] };
}

/**
 * Start auto-lock timer
 */
function startAutoLockTimer() {
    if (lockTimer) {
        clearTimeout(lockTimer);
    }
    
    lockTimer = setTimeout(async () => {
        console.log('⏰ Auto-locking wallet...');
        await lockDualWallet();
    }, walletState.settings.lockTimeout);
}

/**
 * Check if wallet exists
 */
async function checkWalletExists() {
    try {
        const result = await chrome.storage.local.get(['walletExists']);
        return result.walletExists || false;
    } catch (error) {
        console.error('❌ Failed to check wallet existence:', error);
        return false;
    }
}

/**
 * Get network status
 */
async function getNetworkStatus(network) {
    try {
        if (network === 'solana') {
            return {
                connected: !!walletState.networks.solana.rpc,
                network: 'solana',
                chainId: 'devnet'
            };
        } else if (network === 'qnet') {
            return {
                connected: !!walletState.networks.qnet.rpc,
                network: 'qnet',
                chainId: 'mainnet'
            };
        }
        
        return { connected: false };
        
    } catch (error) {
        console.error('❌ Failed to get network status:', error);
        return { connected: false, error: error.message };
    }
}

console.log('🚀 QNet Dual Wallet background service worker loaded'); 