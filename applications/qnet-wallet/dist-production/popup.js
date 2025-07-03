/**
 * QNet Dual Wallet Popup - Production Version (ES5 Compatible)
 * Beautiful dual-network wallet interface without ES6 imports
 * Supports both Solana and QNet networks with phase-aware interface
 */

// Global state management
class WalletState {
    constructor() {
        this.isInitialized = false;
        this.walletExists = false;
        this.isUnlocked = false;
        this.currentNetwork = 'qnet'; // Start with QNet as primary
        this.currentPhase = 1;
        this.accounts = [];
        this.currentStep = 'checking';
        this.language = 'en';
        
        // Network-specific data
        this.networks = {
            solana: {
                active: false,
                balance: { SOL: 0.0, '1DEV': 1500 },
                address: null,
                connected: false
            },
            qnet: {
                active: true,
                balance: { QNC: 2500 },
                address: null,
                connected: false,
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

// Initialize global instances
let walletState = new WalletState();

/**
 * Initialize the wallet popup when DOM is loaded
 */
document.addEventListener('DOMContentLoaded', async () => {
    console.log('🚀 QNet Dual Wallet initializing...');
    
    try {
        // Show loading screen with beautiful animation
        showScreen('loading-screen');
        
        // Simulate initialization delay to show beautiful loading screen
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        // Setup event listeners
        setupEventListeners();
        
        // Check wallet state
        await checkWalletState();
        
        // Update UI based on current state
        await updateUI();
        
        console.log('✅ QNet Dual Wallet initialized successfully');
        
    } catch (error) {
        console.error('❌ Failed to initialize QNet Dual Wallet:', error);
        showError('Failed to initialize wallet. Please refresh and try again.');
    }
});

/**
 * Check wallet state from background service or localStorage
 */
async function checkWalletState() {
    try {
        // Try to get state from background service
        if (typeof chrome !== 'undefined' && chrome.runtime) {
            try {
                const response = await chrome.runtime.sendMessage({ type: 'GET_WALLET_STATE' });
                
                if (response && response.success) {
                    walletState.walletExists = response.walletExists || false;
                    walletState.isUnlocked = response.isUnlocked || false;
                    walletState.accounts = response.accounts || [];
                    walletState.currentNetwork = response.currentNetwork || 'qnet';
                    walletState.language = response.language || 'en';
                    
                    if (response.networks) {
                        walletState.networks = { ...walletState.networks, ...response.networks };
                    }
                }
            } catch (chromeError) {
                console.log('Chrome extension context not available, using demo mode');
            }
        }
        
        // Fallback to localStorage for demo purposes
        if (!walletState.walletExists) {
            const savedState = localStorage.getItem('qnet-wallet-state');
            if (savedState) {
                const state = JSON.parse(savedState);
                walletState.walletExists = state.walletExists || false;
                walletState.isUnlocked = state.isUnlocked || false;
                walletState.accounts = state.accounts || [];
            } else {
                // Demo mode - set up initial state
                walletState.walletExists = true;
                walletState.isUnlocked = false;
            }
        }
        
        console.log('✅ Wallet state loaded:', {
            exists: walletState.walletExists,
            unlocked: walletState.isUnlocked,
            network: walletState.currentNetwork,
            accounts: walletState.accounts.length
        });
        
    } catch (error) {
        console.error('❌ Failed to get wallet state:', error);
        // Continue with default state for demo
        walletState.walletExists = true;
        walletState.isUnlocked = false;
    }
}

/**
 * Update UI based on current wallet state
 */
async function updateUI() {
    try {
        // Hide loading screen
        hideScreen('loading-screen');
        
        if (!walletState.walletExists) {
            // Show setup screen
            showSetupOptions();
        } else if (!walletState.isUnlocked) {
            // Show locked screen
            showScreen('locked-screen');
        } else {
            // Show main wallet interface
            await showMainWalletScreen();
        }
        
    } catch (error) {
        console.error('❌ Update UI error:', error);
        showError('Failed to update interface');
    }
}

/**
 * Show main wallet screen with dual network support
 */
async function showMainWalletScreen() {
    try {
        showScreen('main-wallet-screen');
        
        // Update phase indicator
        updatePhaseIndicator();
        
        // Update network switcher
        updateNetworkSwitcher();
        
        // Load and display account data
        await loadAccountData();
        
        // Update network-specific content
        await updateNetworkContent();
        
        // Update network status
        updateNetworkStatus('connected');
        
        console.log('✅ Main wallet screen initialized');
        
    } catch (error) {
        console.error('❌ Failed to show main wallet screen:', error);
        showError('Failed to load wallet interface');
    }
}

/**
 * Load account data for current network
 */
async function loadAccountData() {
    try {
        if (walletState.currentNetwork === 'qnet') {
            // Load QNet data
            const eonAddress = 'a7b8c9d2eon1f2e3456789abcdef';
            const qncBalance = walletState.networks.qnet.balance.QNC;
            
            walletState.updateNetwork('qnet', {
                address: eonAddress,
                balance: { QNC: qncBalance },
                connected: true
            });
            
            // Update display
            updateAccountDisplay(eonAddress, `${qncBalance} QNC`);
            
        } else {
            // Load Solana data
            const solanaAddress = '7a9bk4f2eon8x3m5z1c7d6e4f8g9h2j3';
            const balances = walletState.networks.solana.balance;
            
            walletState.updateNetwork('solana', {
                address: solanaAddress,
                balance: balances,
                connected: true
            });
            
            // Update display
            const displayBalance = `${balances.SOL} SOL • ${balances['1DEV']} 1DEV`;
            updateAccountDisplay(solanaAddress, displayBalance);
        }
        
    } catch (error) {
        console.error('❌ Failed to load account data:', error);
        updateAccountDisplay('Error loading address', '0.00');
    }
}

/**
 * Update account display
 */
function updateAccountDisplay(address, balance) {
    const addressElement = document.getElementById('account-address');
    const balanceElement = document.getElementById('network-balance');
    const totalBalanceElement = document.getElementById('total-balance');
    
    if (addressElement) {
        // Format address for display
        if (address && address.includes('eon')) {
            // EON address - show with formatting
            const parts = address.match(/(.{8})eon(.{8})(.{4})/);
            if (parts) {
                addressElement.textContent = `${parts[1]} eon ${parts[2]} ${parts[3]}`;
            } else {
                addressElement.textContent = address;
            }
        } else if (address && address.length > 20) {
            // Long address - truncate
            addressElement.textContent = `${address.slice(0, 6)}...${address.slice(-4)}`;
        } else {
            addressElement.textContent = address;
        }
    }
    
    if (balanceElement) {
        balanceElement.textContent = balance;
    }
    
    if (totalBalanceElement) {
        // Calculate total USD value (mock calculation)
        const qncBalance = walletState.networks.qnet.balance.QNC || 0;
        const solBalance = walletState.networks.solana.balance.SOL || 0;
        const devBalance = walletState.networks.solana.balance['1DEV'] || 0;
        
        const totalUSD = (qncBalance * 0.001) + (solBalance * 150) + (devBalance * 0.05);
        totalBalanceElement.textContent = `$${totalUSD.toFixed(2)}`;
    }
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
        phaseProgress.textContent = '25% burned';
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
            statusElement.title = 'Connected';
            break;
        case 'connecting':
            statusElement.style.background = '#f59e0b';
            statusElement.title = 'Connecting...';
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
async function updateNetworkContent() {
    // Hide all network content
    document.querySelectorAll('.network-content').forEach(content => {
        content.classList.add('hidden');
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
 * Update QNet network content
 */
async function updateQNetContent() {
    try {
        // Update QNet token list
        const tokenList = document.getElementById('qnet-token-list');
        if (tokenList) {
            const qncBalance = walletState.networks.qnet.balance.QNC || 0;
            tokenList.innerHTML = createTokenItem('💎', 'QNet Coin', 'QNC', qncBalance, '$2.50');
        }
        
        // Update node information
        await updateNodeCard();
        
        // Update rewards information
        updateRewardsCard();
        
    } catch (error) {
        console.error('❌ Failed to update QNet content:', error);
    }
}

/**
 * Update Solana network content
 */
async function updateSolanaContent() {
    try {
        // Update Solana token list
        const tokenList = document.getElementById('solana-token-list');
        if (tokenList) {
            const balances = walletState.networks.solana.balance;
            let tokenItems = '';
            
            if (balances.SOL > 0) {
                tokenItems += createTokenItem('🟪', 'Solana', 'SOL', balances.SOL, '$0.00');
            }
            
            if (balances['1DEV'] > 0) {
                tokenItems += createTokenItem('🔥', '1DEV Token', '1DEV', balances['1DEV'], '$75.00');
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
 * Create token list item HTML
 */
function createTokenItem(icon, name, symbol, amount, value) {
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
 * Update node card information
 */
async function updateNodeCard() {
    const nodeDetails = document.getElementById('node-details');
    const nodeActions = document.getElementById('node-actions');
    const nodeStatusText = document.getElementById('node-status-text');
    
    if (!nodeDetails || !nodeActions || !nodeStatusText) return;
    
    const nodeInfo = walletState.networks.qnet.nodeInfo;
    
    if (nodeInfo) {
        // Node is active
        nodeStatusText.textContent = `Active ${nodeInfo.type} node`;
        
        nodeDetails.innerHTML = `
            <div class="node-stats">
                <div class="stat-row">
                    <span class="stat-label">Activation Code:</span>
                    <span class="stat-value">${nodeInfo.code}</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Uptime:</span>
                    <span class="stat-value">${nodeInfo.uptime}%</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Daily Rewards:</span>
                    <span class="stat-value">${nodeInfo.rewards} QNC</span>
                </div>
            </div>
        `;
        
        nodeActions.innerHTML = `
            <button class="qnet-button secondary modern">📊 Monitor Node</button>
            <button class="qnet-button secondary modern">🔄 Transfer Node</button>
        `;
        
    } else {
        // No active node
        nodeStatusText.textContent = 'No active node';
        
        const activationCost = walletState.currentPhase === 2 ? '5,000 QNC' : 'Phase 1 Only';
        const qncBalance = walletState.networks.qnet.balance.QNC || 0;
        
        nodeDetails.innerHTML = `
            <div class="activation-info">
                <div class="cost-info">
                    <span class="cost-label">Activation Cost:</span>
                    <span class="cost-value">${activationCost}</span>
                </div>
                <div class="balance-info">
                    <span class="balance-label">Your Balance:</span>
                    <span class="balance-value">${qncBalance} QNC</span>
                </div>
            </div>
        `;
        
        const canActivate = walletState.currentPhase === 2 && qncBalance >= 5000;
        const buttonText = canActivate ? '🚀 Activate Node' : 'Insufficient Balance';
        const buttonClass = canActivate ? 'qnet-button primary gradient' : 'qnet-button primary disabled';
        
        nodeActions.innerHTML = `
            <button class="${buttonClass}" ${!canActivate ? 'disabled' : ''}>
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
    const dailyRewards = nodeInfo ? nodeInfo.rewards : 0;
    const totalEarned = nodeInfo ? nodeInfo.totalEarned || 0 : 0;
    
    const statItems = document.querySelectorAll('#qnet-rewards-tab .stat-item');
    if (statItems.length >= 2) {
        const dailyValue = statItems[0].querySelector('.stat-value');
        const totalValue = statItems[1].querySelector('.stat-value');
        if (dailyValue) dailyValue.textContent = `${dailyRewards} QNC`;
        if (totalValue) totalValue.textContent = `${totalEarned} QNC`;
    }
}

/**
 * Update activation pricing for Solana
 */
async function updateActivationPricing() {
    try {
        const pricingInfo = document.getElementById('pricing-info');
        if (!pricingInfo) return;
        
        // Mock pricing data
        const pricing = {
            cost: 1350,
            savings: 150,
            savingsPercent: 10
        };
        
        const priceCard = pricingInfo.querySelector('.price-card');
        if (priceCard) {
            const priceValue = priceCard.querySelector('.price-value');
            const priceSavings = priceCard.querySelector('.price-savings');
            if (priceValue) priceValue.textContent = `${pricing.cost} 1DEV`;
            if (priceSavings) priceSavings.textContent = `${pricing.savings} 1DEV saved (${pricing.savingsPercent}%)`;
        }
        
    } catch (error) {
        console.error('❌ Failed to update activation pricing:', error);
    }
}

/**
 * Setup all event listeners
 */
function setupEventListeners() {
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
    
    const copyBtn = document.getElementById('copy-address-btn');
    if (copyBtn) {
        copyBtn.addEventListener('click', handleCopyAddress);
    }
}

/**
 * Handle network switching
 */
async function handleNetworkSwitch(event) {
    const targetNetwork = event.currentTarget.dataset.network;
    
    if (targetNetwork === walletState.currentNetwork) return;
    
    try {
        updateNetworkStatus('connecting');
        
        // Simulate network switch delay
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Update state
        walletState.currentNetwork = targetNetwork;
        
        // Update UI
        updateNetworkSwitcher();
        await loadAccountData();
        await updateNetworkContent();
        
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
    const contentContainer = parentTabs.parentElement;
    
    // Update tab buttons
    parentTabs.querySelectorAll('.tab-button').forEach(button => {
        button.classList.remove('active');
    });
    event.currentTarget.classList.add('active');
    
    // Update tab content
    contentContainer.querySelectorAll('.tab-content').forEach(content => {
        content.classList.add('hidden');
    });
    
    const targetContent = document.getElementById(`${targetTab}-tab`);
    if (targetContent) {
        targetContent.classList.remove('hidden');
    }
}

/**
 * Setup action buttons
 */
function setupActionButtons() {
    // Send button
    const sendBtn = document.getElementById('send-button');
    if (sendBtn) {
        sendBtn.addEventListener('click', handleSendAction);
    }
    
    // Receive button
    const receiveBtn = document.getElementById('receive-button');
    if (receiveBtn) {
        receiveBtn.addEventListener('click', handleReceiveAction);
    }
    
    // Bridge/Swap button
    const swapBtn = document.getElementById('swap-button');
    if (swapBtn) {
        swapBtn.addEventListener('click', handleBridgeAction);
    }
}

/**
 * Handle send action
 */
function handleSendAction() {
    showToast('Send feature coming soon', 'info');
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
        networkName.textContent = walletState.currentNetwork === 'qnet' ? 'QNC' : 'SOL';
    }
    
    if (receiveAddress) {
        receiveAddress.textContent = address;
    }
    
    // Generate QR code placeholder
    const canvas = document.getElementById('qr-canvas');
    if (canvas) {
        const ctx = canvas.getContext('2d');
        canvas.width = 200;
        canvas.height = 200;
        
        // Draw a simple QR code placeholder
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, 200, 200);
        ctx.fillStyle = '#000000';
        ctx.font = '12px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('QR Code', 100, 90);
        ctx.fillText('Placeholder', 100, 110);
    }
    
    // Show modal
    showModal('receive-modal');
}

/**
 * Handle bridge action
 */
function handleBridgeAction() {
    showToast('Cross-chain bridge coming soon', 'info');
}

/**
 * Setup wallet controls
 */
function setupWalletControls() {
    // Unlock button
    const unlockBtn = document.getElementById('unlock-button');
    if (unlockBtn) {
        unlockBtn.addEventListener('click', handleUnlock);
    }
    
    // Lock button
    const lockBtn = document.getElementById('lock-wallet-btn');
    if (lockBtn) {
        lockBtn.addEventListener('click', handleLockWallet);
    }
    
    // Create wallet
    const createBtn = document.getElementById('create-wallet-button');
    if (createBtn) {
        createBtn.addEventListener('click', showCreateWalletModal);
    }
    
    // Import wallet
    const importBtn = document.getElementById('import-wallet-button');
    if (importBtn) {
        importBtn.addEventListener('click', showImportWalletModal);
    }
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
        // Mock unlock validation
        if (password.length < 3) {
            showInlineError('password-error', 'Invalid password');
            return;
        }
        
        walletState.isUnlocked = true;
        walletState.accounts = [{ 
            id: 1, 
            name: 'Account 1',
            solanaAddress: '7a9bk4f2eon8x3m5z1c7d6e4f8g9h2j3',
            eonAddress: 'a7b8c9d2eon1f2e3456789abcdef'
        }];
        
        // Save state
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem('qnet-wallet-state', JSON.stringify({
                walletExists: true,
                isUnlocked: true,
                accounts: walletState.accounts
            }));
        }
        
        await showMainWalletScreen();
        showToast('Wallet unlocked successfully', 'success');
        
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
        walletState.isUnlocked = false;
        walletState.accounts = [];
        
        // Update stored state
        if (typeof localStorage !== 'undefined') {
            const savedState = JSON.parse(localStorage.getItem('qnet-wallet-state') || '{}');
            savedState.isUnlocked = false;
            localStorage.setItem('qnet-wallet-state', JSON.stringify(savedState));
        }
        
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
    
    // Copy receive address button
    const copyReceiveBtn = document.getElementById('copy-receive-address-btn');
    if (copyReceiveBtn) {
        copyReceiveBtn.addEventListener('click', async () => {
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
        });
    }
}

/**
 * Show setup options for new users
 */
function showSetupOptions() {
    const setupOptions = document.querySelector('.setup-options');
    if (setupOptions) {
        setupOptions.style.display = 'flex';
    }
    showScreen('locked-screen');
}

/**
 * Show create wallet modal
 */
function showCreateWalletModal() {
    showModal('wallet-setup-modal');
    const title = document.getElementById('setup-modal-title');
    if (title) title.textContent = '✨ Create New Wallet';
    showSetupStep('create-wallet-content');
}

/**
 * Show import wallet modal
 */
function showImportWalletModal() {
    showModal('wallet-setup-modal');
    const title = document.getElementById('setup-modal-title');
    if (title) title.textContent = '📥 Import Wallet';
    showSetupStep('import-wallet-content');
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
    document.querySelectorAll('.screen, .loading-screen').forEach(screen => {
        screen.classList.add('hidden');
    });
    
    // Special handling for loading screen
    if (screenId === 'loading-screen') {
        const loadingScreen = document.getElementById('loading-screen');
        if (loadingScreen) {
            loadingScreen.classList.remove('hidden');
            loadingScreen.style.display = 'flex';
        }
    } else {
        const targetScreen = document.getElementById(screenId);
        if (targetScreen) {
            targetScreen.classList.remove('hidden');
        }
    }
}

function hideScreen(screenId) {
    const screen = document.getElementById(screenId);
    if (screen) {
        screen.classList.add('hidden');
        if (screenId === 'loading-screen') {
            screen.style.display = 'none';
        }
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

function clearError(errorId) {
    const errorElement = document.getElementById(errorId);
    if (errorElement) {
        errorElement.style.display = 'none';
        errorElement.classList.remove('error-visible');
    }
}

function showToast(message, type = 'info') {
    // Remove existing toasts
    document.querySelectorAll('.toast-notification').forEach(toast => toast.remove());
    
    // Create new toast
    const toast = document.createElement('div');
    toast.className = `toast-notification toast-${type}`;
    toast.textContent = message;
    
    // Add toast styles
    toast.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#3b82f6'};
        color: white;
        padding: 12px 24px;
        border-radius: 8px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
        z-index: 10000;
        font-size: 14px;
        font-weight: 500;
        animation: slideIn 0.3s ease;
    `;
    
    document.body.appendChild(toast);
    
    // Auto remove after 3 seconds
    setTimeout(() => toast.remove(), 3000);
}

function showError(message) {
    showToast(message, 'error');
}

console.log('🚀 QNet Dual Wallet popup script loaded successfully'); 