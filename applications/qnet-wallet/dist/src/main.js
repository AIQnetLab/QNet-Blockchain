/**
 * QNet Dual Wallet Main Entry Point - Production Version
 * Integrates all existing components: DualNetworkManager, SolanaIntegration, QNetIntegration, EONAddressGenerator
 * Modern dual-network interface with phase-aware functionality
 */

import { QNetDualWallet } from './wallet/QNetDualWallet.js';
import { DualNetworkManager } from './network/DualNetworkManager.js';
import { SolanaIntegration } from './integration/SolanaIntegration.js';
import { QNetIntegration } from './integration/QNetIntegration.js';
import { EONAddressGenerator } from './crypto/EONAddressGenerator.js';
import { I18n } from './i18n/I18n.js';

// Global state for dual-network wallet
class DualWalletState {
    constructor() {
        this.isInitialized = false;
        this.walletExists = false;
        this.isUnlocked = false;
        this.currentNetwork = 'qnet'; // Start with QNet as primary
        this.currentPhase = 1;
        this.accounts = [];
        this.language = 'en';
        
        // Dual network data
        this.networks = {
            solana: {
                active: false,
                balance: { SOL: 0, '1DEV': 0 },
                address: null,
                connection: null
            },
            qnet: {
                active: true,
                balance: { QNC: 0 },
                address: null, // EON address
                connection: null,
                nodeInfo: null
            }
        };
    }

    updateNetwork(network, data) {
        this.networks[network] = { ...this.networks[network], ...data };
    }

    getCurrentNetworkData() {
        return this.networks[this.currentNetwork];
    }
}

// Global instances
let walletState = new DualWalletState();
let dualWallet = null;
let networkManager = null;
let solanaIntegration = null;
let qnetIntegration = null;
let eonGenerator = null;
let i18n = null;

/**
 * Initialize QNet Dual Wallet
 */
async function initializeDualWallet() {
    console.log('🚀 Initializing QNet Dual Wallet...');
    
    try {
        // Show loading screen
        showScreen('loading-screen');
        console.log('✅ Loading screen shown');
        
        // Initialize i18n system
        console.log('🌐 Initializing i18n...');
        i18n = new I18n();
        await i18n.initialize();
        console.log('✅ I18n initialized');
        
        // Initialize core components
        console.log('🔑 Initializing EON generator...');
        eonGenerator = new EONAddressGenerator();
        console.log('✅ EON generator ready');
        
        console.log('🌐 Initializing network manager...');
        networkManager = new DualNetworkManager();
        await networkManager.initialize();
        console.log('✅ Network manager ready');
        
        // Initialize dual wallet with all components
        console.log('💎 Initializing dual wallet...');
        dualWallet = new QNetDualWallet(i18n);
        await dualWallet.initialize();
        console.log('✅ Dual wallet ready');
        
        // Get component references
        console.log('🔗 Getting component references...');
        solanaIntegration = dualWallet.solanaIntegration;
        qnetIntegration = dualWallet.qnetIntegration;
        console.log('✅ Component references ready');
        
        // Check wallet state from storage/background
        console.log('💾 Loading wallet state...');
        await loadWalletState();
        console.log('✅ Wallet state loaded');
        
        // Setup event listeners
        console.log('🎯 Setting up event listeners...');
        setupAllEventListeners();
        console.log('✅ Event listeners ready');
        
        // Update UI based on current state
        console.log('🎨 Updating main UI...');
        await updateMainUI();
        console.log('✅ Main UI updated');
        
        walletState.isInitialized = true;
        console.log('✅ QNet Dual Wallet initialized successfully');
        
    } catch (error) {
        console.error('❌ Failed to initialize QNet Dual Wallet:', error);
        showError('Failed to initialize wallet. Please refresh and try again.');
    }
}

/**
 * Load wallet state from background/storage
 */
async function loadWalletState() {
    try {
        // Try to get state from background script first
        if (typeof chrome !== 'undefined' && chrome.runtime) {
            const response = await chrome.runtime.sendMessage({ type: 'GET_WALLET_STATE' });
            
            if (response?.success) {
                walletState.walletExists = response.walletExists || false;
                walletState.isUnlocked = response.isUnlocked || false;
                walletState.accounts = response.accounts || [];
                walletState.currentNetwork = response.currentNetwork || 'qnet';
                walletState.language = response.language || 'en';
                
                console.log('✅ Wallet state loaded from background:', {
                    exists: walletState.walletExists,
                    unlocked: walletState.isUnlocked,
                    network: walletState.currentNetwork
                });
                return;
            }
        }
        
        // Fallback: check local storage
        const stored = localStorage.getItem('qnet_wallet_state');
        if (stored) {
            const state = JSON.parse(stored);
            Object.assign(walletState, state);
            console.log('✅ Wallet state loaded from localStorage');
        }
        
    } catch (error) {
        console.error('❌ Failed to load wallet state:', error);
        // Continue with default state
    }
}

/**
 * Save wallet state to storage
 */
async function saveWalletState() {
    try {
        const stateToSave = {
            walletExists: walletState.walletExists,
            isUnlocked: walletState.isUnlocked,
            currentNetwork: walletState.currentNetwork,
            language: walletState.language
        };
        
        localStorage.setItem('qnet_wallet_state', JSON.stringify(stateToSave));
        
        // Also try to save via background script
        if (typeof chrome !== 'undefined' && chrome.runtime) {
            await chrome.runtime.sendMessage({
                type: 'SAVE_WALLET_STATE',
                state: stateToSave
            });
        }
        
    } catch (error) {
        console.error('❌ Failed to save wallet state:', error);
    }
}

/**
 * Update main UI based on wallet state
 */
async function updateMainUI() {
    try {
        // Hide loading screen
        hideScreen('loading-screen');
        
        if (!walletState.walletExists) {
            // Show setup options
            showSetupScreen();
        } else if (!walletState.isUnlocked) {
            // Show locked screen
            showScreen('locked-screen');
        } else {
            // Show main wallet interface with dual network
            await showDualWalletInterface();
        }
        
    } catch (error) {
        console.error('❌ Update UI error:', error);
        showError('Failed to update interface');
    }
}

/**
 * Show dual wallet interface with both networks
 */
async function showDualWalletInterface() {
    try {
        showScreen('main-wallet-screen');
        
        // Detect current phase
        walletState.currentPhase = await networkManager.detectCurrentPhase();
        
        // Update phase indicator
        updatePhaseIndicator();
        
        // Initialize both networks
        await initializeBothNetworks();
        
        // Update network switcher
        updateNetworkSwitcher();
        
        // Load account data for current network
        await loadCurrentNetworkData();
        
        // Update network-specific content
        await updateNetworkSpecificContent();
        
        console.log('✅ Dual wallet interface loaded');
        
    } catch (error) {
        console.error('❌ Failed to show dual wallet interface:', error);
        showError('Failed to load wallet interface');
    }
}

/**
 * Initialize both Solana and QNet networks
 */
async function initializeBothNetworks() {
    try {
        console.log('🔗 Initializing dual network connections...');
        
        // Initialize Solana network
        await solanaIntegration.initialize();
        walletState.updateNetwork('solana', { connection: true });
        
        // Initialize QNet network  
        await qnetIntegration.initialize();
        walletState.updateNetwork('qnet', { connection: true });
        
        // Switch to current network
        if (walletState.currentNetwork === 'solana') {
            await networkManager.switchToSolana();
        } else {
            await networkManager.switchToQNet();
        }
        
        // Update status
        updateNetworkStatus('connected');
        
        console.log('✅ Both networks initialized successfully');
        
    } catch (error) {
        console.error('❌ Network initialization failed:', error);
        updateNetworkStatus('error');
        throw error;
    }
}

/**
 * Load data for current network
 */
async function loadCurrentNetworkData() {
    try {
        if (!walletState.accounts.length) return;
        
        const currentAccount = walletState.accounts[0];
        
        if (walletState.currentNetwork === 'qnet') {
            // Load QNet data with EON address
            console.log('📡 Loading QNet data...');
            
            let eonAddress = walletState.networks.qnet.address;
            if (!eonAddress) {
                // Generate EON address from seed
                eonAddress = await networkManager.getOrCreateEonAddress();
            }
            
            // Get QNC balance - not shown per user request
            const qncBalance = 0;
            
            // Get node information
            const nodeInfo = await qnetIntegration.getNodeInfo(eonAddress);
            
            // Update state
            walletState.updateNetwork('qnet', {
                address: eonAddress,
                balance: { QNC: qncBalance },
                nodeInfo: nodeInfo,
                active: true
            });
            
            // Update display
            updateAccountDisplay(eonAddress, `${qncBalance} QNC`);
            
            console.log('✅ QNet data loaded:', { eonAddress, nodeInfo });
            
        } else {
            // Load Solana data
            console.log('📡 Loading Solana data...');
            
            const solanaAddress = currentAccount.solanaAddress;
            
            // Get SOL balance
            const solBalance = await solanaIntegration.getSOLBalance(solanaAddress);
            
            // Get 1DEV balance
            const oneDevBalance = await solanaIntegration.getOneDevBalance(solanaAddress);
            
            const balances = { SOL: solBalance, '1DEV': oneDevBalance };
            
            // Update state
            walletState.updateNetwork('solana', {
                address: solanaAddress,
                balance: balances,
                active: true
            });
            
            // Update display
            const displayBalance = `${solBalance} SOL • ${oneDevBalance} 1DEV`;
            updateAccountDisplay(solanaAddress, displayBalance);
            
            console.log('✅ Solana data loaded:', { solanaAddress, balances });
        }
        
    } catch (error) {
        console.error('❌ Failed to load network data:', error);
        updateAccountDisplay('Error loading address', '0.00');
        }
    }

    /**
 * Update account display with current network data
 */
function updateAccountDisplay(address, balance) {
    const addressElement = document.getElementById('account-address');
    const balanceElement = document.getElementById('network-balance');
    const totalBalanceElement = document.getElementById('total-balance');
    
    if (addressElement) {
        // Format address for display
        if (address?.includes('eon')) {
            // EON address - show with beautiful formatting
            const formatted = formatEONAddress(address);
            addressElement.textContent = formatted;
            addressElement.title = address; // Full address on hover
        } else if (address?.length > 20) {
            // Long address - truncate
            addressElement.textContent = `${address.slice(0, 6)}...${address.slice(-4)}`;
            addressElement.title = address; // Full address on hover
        } else {
            addressElement.textContent = address || 'No address';
        }
    }
    
    if (balanceElement) {
        balanceElement.textContent = balance;
    }
    
    if (totalBalanceElement) {
        // Show network-specific balance as main balance
        totalBalanceElement.textContent = balance;
    }
}

/**
 * Format EON address for beautiful display
 */
function formatEONAddress(address) {
    if (!address?.includes('eon')) return address;
    
    const match = address.match(/(.{19})eon(.{15})(.{4})/);
    if (match) {
        return `${match[1]} eon ${match[2]} ${match[3]}`;
    }
    return address;
}

/**
 * Update phase indicator
 */
function updatePhaseIndicator() {
    const phaseText = document.getElementById('phase-text');
    const phaseProgress = document.getElementById('phase-progress');
    
    if (!phaseText || !phaseProgress) return;
    
    if (walletState.currentPhase === 1) {
        phaseText.textContent = 'Phase 1: 1DEV Burn Activation';
        phaseProgress.textContent = '25% burned'; // Would be fetched from contract
    } else {
        phaseText.textContent = 'Phase 2: QNC Pool 3 Activation';
        phaseProgress.textContent = 'Native activation active';
    }
}

/**
 * Update network switcher UI
 */
function updateNetworkSwitcher() {
    const networkTabs = document.querySelectorAll('.network-tab');
    
    networkTabs.forEach(tab => {
        tab.classList.remove('active');
        if (tab.dataset.network === walletState.currentNetwork) {
            tab.classList.add('active');
        }
        });
    }

    /**
 * Update network status indicator
 */
function updateNetworkStatus(status) {
    const statusElement = document.getElementById('network-status');
    if (!statusElement) return;
    
    statusElement.className = 'network-status';
    
    switch (status) {
        case 'connected':
            statusElement.style.background = '#10b981';
            statusElement.title = 'Connected to both networks';
                break;
        case 'connecting':
            statusElement.style.background = '#f59e0b';
            statusElement.title = 'Connecting to networks...';
                break;
        case 'error':
            statusElement.style.background = '#ef4444';
            statusElement.title = 'Connection error';
                break;
        }
    }

    /**
 * Update network-specific content
 */
async function updateNetworkSpecificContent() {
    // Hide all network content
    document.querySelectorAll('.network-content').forEach(content => {
        content.classList.add('hidden');
        content.classList.remove('active');
    });
    
    // Show current network content
    const currentContent = document.getElementById(`${walletState.currentNetwork}-content`);
    if (currentContent) {
        currentContent.classList.remove('hidden');
        currentContent.classList.add('active');
    }
    
    // Update network-specific data
    if (walletState.currentNetwork === 'qnet') {
        await updateQNetContent();
    } else {
        await updateSolanaContent();
    }
}

/**
 * Update QNet-specific content
 */
async function updateQNetContent() {
    try {
        // Update QNet token list
        const tokenList = document.getElementById('qnet-token-list');
        if (tokenList) {
            // No balance or price shown per user request
            tokenList.innerHTML = createTokenItemHTML('💎', 'QNet Coin', 'QNC', 0, '');
        }
        
        // Update node card
        await updateNodeCard();
        
        // Update rewards card
        updateRewardsCard();
        
                    } catch (error) {
        console.error('❌ Failed to update QNet content:', error);
    }
}

/**
 * Update Solana-specific content
 */
async function updateSolanaContent() {
    try {
        // Update Solana token list
        const tokenList = document.getElementById('solana-token-list');
        if (tokenList) {
            const balances = walletState.networks.solana.balance || {};
            let tokenItems = '';
            
            if (balances.SOL > 0) {
                tokenItems += createTokenItemHTML('🟪', 'Solana', 'SOL', balances.SOL, '$0.00');
            }
            
            if (balances['1DEV'] > 0) {
                tokenItems += createTokenItemHTML('🔥', '1DEV Token', '1DEV', balances['1DEV'], '$0.00');
            }
            
            tokenList.innerHTML = tokenItems || '<li class="no-tokens">No tokens found</li>';
        }
        
        // Update activation pricing
        await updateActivationPricing();
        
    } catch (error) {
        console.error('❌ Failed to update Solana content:', error);
    }
}

/**
 * Create token item HTML
 */
function createTokenItemHTML(icon, name, symbol, amount, value) {
    return `
        <li class="token-item">
            <div class="token-icon">${icon}</div>
            <div class="token-info">
                <div class="token-name">${name}</div>
                <div class="token-symbol">${symbol}</div>
            </div>
            <div class="token-balance">
                <div class="token-amount">${amount}</div>
                <div class="token-value">${value}</div>
            </div>
        </li>
    `;
}

/**
 * Update node card with current node status
 */
async function updateNodeCard() {
    const nodeDetails = document.getElementById('node-details');
    const nodeActions = document.getElementById('node-actions');
    const nodeStatusText = document.getElementById('node-status-text');
    
    if (!nodeDetails || !nodeActions || !nodeStatusText) return;
    
    const nodeInfo = walletState.networks.qnet.nodeInfo;
    
    if (nodeInfo) {
        // Active node display
        nodeStatusText.textContent = `Active ${nodeInfo.type} node`;
        
        nodeDetails.innerHTML = `
            <div class="node-stats">
                <div class="stat-row">
                    <span class="stat-label">Code:</span>
                    <span class="stat-value">${nodeInfo.code}</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Uptime:</span>
                    <span class="stat-value">${nodeInfo.uptime || 98.5}%</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Daily Rewards:</span>
                    <span class="stat-value">${nodeInfo.rewards || 12.5} QNC</span>
                </div>
            </div>
        `;
        
        nodeActions.innerHTML = `
            <button class="qnet-button secondary modern" onclick="monitorNode()">📊 Monitor</button>
            <button class="qnet-button secondary modern" onclick="migrateDevice()">🔄 Migrate</button>
        `;
        
    } else {
        // No active node
        nodeStatusText.textContent = 'No active node';
        
        const activationCost = walletState.currentPhase === 2 ? '5,000 QNC' : 'Phase 1 activation only';
        const qncBalance = walletState.networks.qnet.balance?.QNC || 0;
        
        nodeDetails.innerHTML = `
            <div class="activation-info">
                <div class="cost-info">
                    <span class="cost-label">Cost:</span>
                    <span class="cost-value">${activationCost}</span>
                </div>
                <div class="balance-info">
                    <span class="balance-label">Balance:</span>
                    <span class="balance-value">${qncBalance} QNC</span>
                </div>
            </div>
        `;
        
        const canActivate = walletState.currentPhase === 2 && qncBalance >= 5000;
        const buttonText = canActivate ? '🚀 Activate Node' : 'Insufficient Balance';
        const buttonClass = canActivate ? 'qnet-button primary gradient' : 'qnet-button primary disabled';
        
        nodeActions.innerHTML = `
            <button class="${buttonClass}" onclick="activateNode()" ${!canActivate ? 'disabled' : ''}>
                ${buttonText}
            </button>
        `;
    }
}

/**
 * Update rewards card
 */
function updateRewardsCard() {
    const nodeInfo = walletState.networks.qnet.nodeInfo;
    const dailyRewards = nodeInfo?.rewards || 0;
    const totalEarned = nodeInfo?.totalEarned || 0;
    
    const statItems = document.querySelectorAll('#qnet-rewards-tab .stat-item');
    if (statItems.length >= 2) {
        statItems[0].querySelector('.stat-value').textContent = `${dailyRewards} QNC`;
        statItems[1].querySelector('.stat-value').textContent = `${totalEarned} QNC`;
    }
}

/**
 * Update activation pricing for Solana
 */
async function updateActivationPricing() {
    try {
        const pricingInfo = document.getElementById('pricing-info');
        if (!pricingInfo) return;
        
        // Get current pricing from Solana integration
        const pricing = await solanaIntegration.getCurrentBurnPricing('light');
        
        const priceCard = pricingInfo.querySelector('.price-card');
        if (priceCard) {
            priceCard.querySelector('.price-value').textContent = `${pricing.cost} 1DEV`;
            priceCard.querySelector('.price-savings').textContent = `${pricing.savings} 1DEV saved (${pricing.savingsPercent}%)`;
        }
        
    } catch (error) {
        console.error('❌ Failed to update activation pricing:', error);
    }
}

/**
 * Setup all event listeners
 */
function setupAllEventListeners() {
    // Network switcher
    document.querySelectorAll('.network-tab').forEach(tab => {
        tab.addEventListener('click', handleNetworkSwitch);
    });
    
    // Tab switching
    document.querySelectorAll('.tab-button').forEach(button => {
        button.addEventListener('click', handleTabSwitch);
    });
    
    // Action buttons
    setupActionButtons();
    
    // Wallet controls
    setupWalletControls();
    
    // Modal controls
    setupModalControls();
    
    // Address copying
    const addressElement = document.getElementById('account-address');
    if (addressElement) {
        addressElement.addEventListener('click', handleCopyAddress);
    }
}

/**
 * Handle network switching between Solana and QNet
 */
async function handleNetworkSwitch(event) {
    const targetNetwork = event.currentTarget.dataset.network;
    
    if (targetNetwork === walletState.currentNetwork) return;
    
    try {
        updateNetworkStatus('connecting');
        
        // Switch network using network manager
        if (targetNetwork === 'solana') {
            await networkManager.switchToSolana();
        } else {
            await networkManager.switchToQNet();
        }
        
        // Update state
        walletState.currentNetwork = targetNetwork;
        await saveWalletState();
        
        // Update UI
        updateNetworkSwitcher();
        await loadCurrentNetworkData();
        await updateNetworkSpecificContent();
        
        updateNetworkStatus('connected');
        showToast(`Switched to ${targetNetwork.toUpperCase()} network`, 'success');
        
    } catch (error) {
        console.error('❌ Network switch failed:', error);
        updateNetworkStatus('error');
        showToast('Failed to switch network', 'error');
        }
    }

    /**
 * Handle tab switching
 */
function handleTabSwitch(event) {
    const targetTab = event.currentTarget.dataset.tab;
    const parentTabs = event.currentTarget.closest('.tabs-nav');
    
    // Find the content container
    let contentContainer = parentTabs.nextElementSibling;
    while (contentContainer && !contentContainer.classList.contains('tab-content')) {
        contentContainer = contentContainer.nextElementSibling;
    }
    
    // Update tab buttons
    parentTabs.querySelectorAll('.tab-button').forEach(button => {
        button.classList.remove('active');
    });
    event.currentTarget.classList.add('active');
    
    // Update tab content within the same network
    const networkContent = event.currentTarget.closest('.network-content');
    if (networkContent) {
        networkContent.querySelectorAll('.tab-content').forEach(content => {
            content.classList.add('hidden');
        });
        
        const targetContent = document.getElementById(`${targetTab}-tab`);
        if (targetContent) {
            targetContent.classList.remove('hidden');
        }
        }
    }

    /**
 * Setup action buttons
 */
function setupActionButtons() {
    const sendBtn = document.getElementById('send-button');
    const receiveBtn = document.getElementById('receive-button');
    const bridgeBtn = document.getElementById('swap-button');
    
    if (sendBtn) sendBtn.addEventListener('click', handleSendAction);
    if (receiveBtn) receiveBtn.addEventListener('click', handleReceiveAction);
    if (bridgeBtn) bridgeBtn.addEventListener('click', handleBridgeAction);
}

/**
 * Handle send action
 */
function handleSendAction() {
    showToast('Send feature coming soon', 'info');
    // TODO: Implement send functionality
}

/**
 * Handle receive action with QR code
 */
async function handleReceiveAction() {
    const networkData = walletState.getCurrentNetworkData();
    const address = networkData.address;
    
    if (!address) {
        showToast('Address not available', 'error');
        return;
    }
    
    // Update receive modal
    const networkName = document.getElementById('receive-network-name');
    const receiveAddress = document.getElementById('receive-address');
    
    if (networkName) {
        networkName.textContent = walletState.currentNetwork === 'qnet' ? 'QNC' : 'SOL/1DEV';
    }
    
    if (receiveAddress) {
        receiveAddress.textContent = address;
    }
    
    // Generate QR code
    await generateQRCode(address);
    
    // Show modal
    showModal('receive-modal');
}

/**
 * Handle bridge/cross-chain action
 */
function handleBridgeAction() {
    showToast('Cross-chain bridge coming soon', 'info');
    // TODO: Implement bridge functionality
}

/**
 * Generate QR code for address
 */
async function generateQRCode(address) {
    try {
        const canvas = document.getElementById('qr-canvas');
        if (!canvas) return;
        
        // Try to use background script first
        if (typeof chrome !== 'undefined' && chrome.runtime) {
            const response = await chrome.runtime.sendMessage({
                type: 'GENERATE_QR',
                data: address,
                options: { size: 200 }
            });
            
            if (response?.success && response.qrDataUrl) {
                const ctx = canvas.getContext('2d');
                const img = new Image();
                img.onload = () => {
                    canvas.width = img.width;
                    canvas.height = img.height;
                    ctx.drawImage(img, 0, 0);
                };
                img.src = response.qrDataUrl;
                return;
            }
        }
        
        // Fallback: Simple QR placeholder
        const ctx = canvas.getContext('2d');
        canvas.width = 200;
        canvas.height = 200;
        ctx.fillStyle = '#f0f0f0';
        ctx.fillRect(0, 0, 200, 200);
        ctx.fillStyle = '#333';
        ctx.font = '12px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('QR Code', 100, 100);
        
    } catch (error) {
        console.error('❌ QR code generation failed:', error);
    }
}

/**
 * Setup wallet controls
 */
function setupWalletControls() {
    const unlockBtn = document.getElementById('unlock-button');
    const lockBtn = document.getElementById('lock-wallet-btn');
    const createBtn = document.getElementById('create-wallet-button');
    const importBtn = document.getElementById('import-wallet-button');
    
    if (unlockBtn) unlockBtn.addEventListener('click', handleUnlock);
    if (lockBtn) lockBtn.addEventListener('click', handleLockWallet);
    if (createBtn) createBtn.addEventListener('click', () => showWalletSetupModal('create'));
    if (importBtn) importBtn.addEventListener('click', () => showWalletSetupModal('import'));
}

/**
 * Handle wallet unlock
 */
async function handleUnlock() {
    const passwordInput = document.getElementById('password-input');
    const password = passwordInput?.value;
    
    if (!password) {
        showInlineError('password-error', 'Please enter your password');
        return;
    }
    
    try {
        // Try background script unlock
        if (typeof chrome !== 'undefined' && chrome.runtime) {
            const response = await chrome.runtime.sendMessage({
                type: 'UNLOCK_WALLET',
                password: password
            });
            
            if (response?.success) {
                walletState.isUnlocked = true;
                walletState.accounts = response.accounts || [];
                
                await showDualWalletInterface();
                showToast('Wallet unlocked successfully', 'success');
                return;
            } else {
                showInlineError('password-error', response?.error || 'Invalid password');
                return;
            }
        }
        
        // Fallback: Try to unlock using dual wallet
        const unlockResult = await dualWallet.unlockWallet(password);
        
        if (unlockResult.success) {
            walletState.isUnlocked = true;
            walletState.accounts = unlockResult.accounts || [];
            
            await showDualWalletInterface();
            showToast('Wallet unlocked successfully', 'success');
        } else {
            showInlineError('password-error', unlockResult.error || 'Invalid password');
        }
            
        } catch (error) {
        console.error('❌ Unlock failed:', error);
        showInlineError('password-error', 'Failed to unlock wallet');
    }
}

/**
 * Handle wallet lock
 */
async function handleLockWallet() {
    try {
        // Try background script lock
        if (typeof chrome !== 'undefined' && chrome.runtime) {
            await chrome.runtime.sendMessage({ type: 'LOCK_WALLET' });
        }
        
        walletState.isUnlocked = false;
        walletState.accounts = [];
        await saveWalletState();
        
        showScreen('locked-screen');
        showToast('Wallet locked', 'success');
        
    } catch (error) {
        console.error('❌ Lock failed:', error);
        showToast('Failed to lock wallet', 'error');
        }
    }

    /**
 * Handle address copying
 */
async function handleCopyAddress() {
    const networkData = walletState.getCurrentNetworkData();
    const address = networkData.address;
    
    if (!address) {
        showToast('No address to copy', 'error');
        return;
    }
    
    try {
        await navigator.clipboard.writeText(address);
        showToast('Address copied to clipboard', 'success');
    } catch (error) {
        console.error('❌ Copy failed:', error);
        showToast('Failed to copy address', 'error');
    }
}

/**
 * Setup modal controls
 */
function setupModalControls() {
    // Close buttons
    document.querySelectorAll('.close-button').forEach(button => {
        button.addEventListener('click', (e) => {
            const modal = e.target.closest('.modal-overlay');
            if (modal) hideModal(modal.id);
        });
    });
    
    // Modal overlay clicks
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                hideModal(overlay.id);
            }
        });
    });
}

/**
 * Show setup screen for new users
 */
function showSetupScreen() {
    const setupOptions = document.querySelector('.setup-options');
    if (setupOptions) {
        setupOptions.style.display = 'flex';
    }
    showScreen('locked-screen');
}

/**
 * Show wallet setup modal
 */
function showWalletSetupModal(type) {
    const modal = document.getElementById('wallet-setup-modal');
    const title = document.getElementById('setup-modal-title');
    
    if (type === 'create') {
        title.textContent = '✨ Create New Wallet';
        showSetupStep('create-wallet-content');
} else {
        title.textContent = '📥 Import Wallet';
        showSetupStep('import-wallet-content');
    }
    
    showModal('wallet-setup-modal');
}

/**
 * Show setup step
 */
function showSetupStep(stepId) {
    document.querySelectorAll('.setup-step').forEach(step => {
        step.classList.add('hidden');
    });
    
    const targetStep = document.getElementById(stepId);
    if (targetStep) {
        targetStep.classList.remove('hidden');
    }
}

/**
 * Utility functions
 */
function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(screen => {
        screen.classList.add('hidden');
    });
    
    const targetScreen = document.getElementById(screenId);
    if (targetScreen) {
        targetScreen.classList.remove('hidden');
    }
}

function hideScreen(screenId) {
    const screen = document.getElementById(screenId);
    if (screen) {
        screen.classList.add('hidden');
    }
}

function showModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('hidden');
    }
}

function hideModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.add('hidden');
    }
}

function showInlineError(errorId, message) {
    const errorElement = document.getElementById(errorId);
    if (errorElement) {
        errorElement.textContent = message;
        errorElement.style.display = 'block';
        errorElement.classList.add('error-visible');
    }
}

function showToast(message, type = 'info') {
    // Remove existing toasts
    document.querySelectorAll('.toast-notification').forEach(toast => toast.remove());
    
    // Create new toast
    const toast = document.createElement('div');
    toast.className = `toast-notification toast-${type}`;
    toast.textContent = message;
    
    document.body.appendChild(toast);
    
    // Auto remove after 3 seconds
    setTimeout(() => toast.remove(), 3000);
}

function showError(message) {
    showToast(message, 'error');
}

// Global functions for buttons
window.monitorNode = function() {
    showToast('Node monitoring coming soon', 'info');
};

window.migrateDevice = function() {
    showToast('Device migration coming soon', 'info');
};

window.activateNode = async function() {
    showToast('Node activation coming soon', 'info');
    // TODO: Implement node activation
};

window.copyReceiveAddress = async function() {
    const addressElement = document.getElementById('receive-address');
    const address = addressElement?.textContent;
    
    if (address && address !== 'Loading...') {
        try {
            await navigator.clipboard.writeText(address);
            showToast('Address copied to clipboard', 'success');
        } catch (error) {
            showToast('Failed to copy address', 'error');
        }
    }
};

// Initialize when DOM is loaded with timeout
document.addEventListener('DOMContentLoaded', async () => {
    console.log('📱 DOM Content Loaded - Starting wallet initialization');
    
    try {
        // Set a timeout for initialization
        const initPromise = initializeDualWallet();
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Initialization timeout')), 10000)
        );
        
        await Promise.race([initPromise, timeoutPromise]);
        
    } catch (error) {
        console.error('❌ Wallet initialization failed:', error);
        
        // Fallback: Show simple interface
        hideScreen('loading-screen');
        
        if (error.message === 'Initialization timeout') {
            showFallbackInterface();
        } else {
            showErrorInterface(error.message);
        }
    }
});

/**
 * Show fallback interface when full initialization fails
 */
function showFallbackInterface() {
    console.log('🔄 Showing fallback interface');
    
    // Check if wallet exists
    const hasWallet = localStorage.getItem('qnet_wallet_state');
    
    if (hasWallet) {
        showScreen('locked-screen');
        
        // Setup basic unlock functionality
        const unlockBtn = document.getElementById('unlock-button');
        if (unlockBtn) {
            unlockBtn.addEventListener('click', async () => {
                showToast('Please wait, loading wallet components...', 'info');
                // Retry full initialization
                setTimeout(() => window.location.reload(), 2000);
            });
        }
    } else {
        showSetupScreen();
        
        // Setup basic wallet creation
        const createBtn = document.getElementById('create-wallet-button');
        if (createBtn) {
            createBtn.addEventListener('click', () => {
                showToast('Please wait, loading wallet components...', 'info');
                setTimeout(() => window.location.reload(), 2000);
            });
        }
    }
}

/**
 * Show error interface
 */
function showErrorInterface(errorMessage) {
    console.log('❌ Showing error interface:', errorMessage);
    
    const loadingScreen = document.getElementById('loading-screen');
    if (loadingScreen) {
        loadingScreen.innerHTML = `
            <div class="loading-container">
                <div style="font-size: 48px; margin-bottom: 20px;">⚠️</div>
                <h2>Initialization Error</h2>
                <p style="color: #ef4444; margin: 20px 0;">${errorMessage}</p>
                <button onclick="window.location.reload()" class="qnet-button primary">
                    🔄 Reload Wallet
                </button>
            </div>
        `;
    }
};

// Export for debugging
window.DualWalletDebug = {
    walletState,
    dualWallet,
    networkManager,
    solanaIntegration,
    qnetIntegration,
    eonGenerator
};

console.log('🚀 QNet Dual Wallet main script loaded'); 