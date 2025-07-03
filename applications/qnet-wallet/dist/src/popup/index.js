/**
 * QNet Wallet - Main Popup Entry Point
 * Production-ready Chrome Extension with ES6 modules and real Solana integration
 */

// Production version - no npm dependencies - Cache Bust v2025-01-19
import { WalletManager } from './WalletManager.js?v=2025-01-19';
import { UIManager } from './UIManager.js?v=2025-01-19';
import { DynamicPricing } from './DynamicPricing.js?v=2025-01-19';

// Constants
const SOLANA_RPC_URL = 'https://api.devnet.solana.com';
const ONE_DEV_MINT_ADDRESS = '9GcdXAo2EyjNdNLuQoScSVbfJSnh9RdkSS8YYKnGQ8Pf';

// Global instances
let walletManager;
let uiManager;
let solanaConnection;

/**
 * Initialize the QNet Wallet application
 */
async function initialize() {
    try {
        // Hide all content initially
        document.getElementById('main-wallet-screen').style.display = 'none';
        document.getElementById('locked-screen').style.display = 'none';
        document.getElementById('wallet-setup-modal').style.display = 'none';
        
        // Initialize Solana connection (production compatible)
        solanaConnection = {
            rpcUrl: SOLANA_RPC_URL,
            type: 'solana',
            // Wrapper for background script calls
            async getBalance(address) {
                if (typeof chrome !== 'undefined' && chrome.runtime) {
                    const response = await chrome.runtime.sendMessage({
                        type: 'GET_SOL_BALANCE',
                        address: address
                    });
                    return response?.balance || 0;
                }
                return 2.5; // Demo fallback
            }
        };
        
        // Initialize managers
        walletManager = new WalletManager(solanaConnection);
        uiManager = new UIManager(walletManager);
        
        // Check if wallet exists
        const walletExists = await walletManager.hasWallet();
        
        if (walletExists) {
            uiManager.showLockedScreen();
        } else {
            uiManager.showModal('wallet-setup-modal');
            uiManager.showCreateWalletForm();
        }
        
        // Setup event listeners
        setupEventListeners();
        
    } catch (error) {
        uiManager.showError('Failed to initialize wallet');
    }
}

/**
 * Setup all event listeners for the wallet interface
 */
function setupEventListeners() {
    // Unlock wallet
    document.getElementById('unlock-button')?.addEventListener('click', handleUnlock);
    document.getElementById('password-input')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleUnlock();
    });
    
    // Wallet setup
    document.getElementById('create-wallet-button')?.addEventListener('click', handleCreateWallet);
    document.getElementById('import-wallet-button')?.addEventListener('click', handleImportWallet);
    document.getElementById('generate-wallet-button')?.addEventListener('click', handleGenerateWallet);
    document.getElementById('import-wallet-confirm-button')?.addEventListener('click', handleImportWalletConfirm);
    document.getElementById('seed-confirmed-button')?.addEventListener('click', handleSeedConfirmed);
    
    // Seed phrase actions
    document.getElementById('copy-seed-button')?.addEventListener('click', handleCopySeed);
    document.getElementById('download-seed-button')?.addEventListener('click', handleDownloadSeed);
    document.getElementById('verify-seed-button')?.addEventListener('click', handleVerifySeed);
    document.getElementById('back-to-seed-button')?.addEventListener('click', handleBackToSeed);
    
    // Node activation code generation (NOT full activation - browser extension limitation)
    document.getElementById('get-activation-code-button')?.addEventListener('click', handleGetActivationCode);
    
    // Tab switching
    document.querySelectorAll('.tab-button').forEach(button => {
        button.addEventListener('click', (e) => {
            const tabName = e.target.dataset.tab;
            uiManager.switchTab(tabName);
        });
    });
    
    // Modal controls
    document.getElementById('close-setup-modal')?.addEventListener('click', () => {
        uiManager.hideModal('wallet-setup-modal');
    });
    
    document.getElementById('close-settings-modal')?.addEventListener('click', () => {
        uiManager.hideModal('settings-modal');
    });
    
    // Copy address functionality
    document.getElementById('account-address')?.addEventListener('click', handleCopyAddress);
    
    // Settings button and functionality
    document.getElementById('settings-button')?.addEventListener('click', handleSettings);
    setupSettingsListeners();
    
    // Auto-lock timer reset on activity
    document.addEventListener('click', () => uiManager.resetAutoLockTimer());
    document.addEventListener('keypress', () => uiManager.resetAutoLockTimer());
}

/**
 * Setup settings event listeners
 */
function setupSettingsListeners() {
    // Language change
    document.getElementById('language-select')?.addEventListener('change', async (e) => {
        await uiManager.setLanguage(e.target.value);
        await uiManager.saveSettings();
    });
    
    // Auto-lock timer change
    document.getElementById('autolock-select')?.addEventListener('change', async (e) => {
        uiManager.setAutoLockTimer(parseInt(e.target.value));
        await uiManager.saveSettings();
    });
    
    // Network change
    document.getElementById('network-select')?.addEventListener('change', async (e) => {
        await handleNetworkChange(e.target.value);
        await uiManager.saveSettings();
    });
    
    // Security settings
    document.getElementById('change-password-button')?.addEventListener('click', handleChangePassword);
    document.getElementById('show-seed-button')?.addEventListener('click', handleShowSeed);
    document.getElementById('export-private-key-button')?.addEventListener('click', handleExportPrivateKey);
    
    // Connected sites
    document.getElementById('manage-connections-button')?.addEventListener('click', () => {
        uiManager.showConnectedSites();
    });
    
    // Danger zone
    document.getElementById('reset-wallet-button')?.addEventListener('click', handleResetWallet);
    document.getElementById('clear-data-button')?.addEventListener('click', handleClearData);
    
    // Checkbox settings
    const checkboxes = ['biometric-auth', 'enable-dapp-browser', 'enable-push-notifications'];
    checkboxes.forEach(id => {
        document.getElementById(id)?.addEventListener('change', () => {
            uiManager.saveSettings();
        });
    });
}

/**
 * Handle wallet unlock
 */
async function handleUnlock() {
    const passwordInput = document.getElementById('password-input');
    const password = passwordInput.value;
    
    // Clear previous error
    uiManager.clearError('password-error');
    
    if (!password) {
        uiManager.showInlineError('password-error', 'Please enter your password');
        return;
    }
    
    try {
        await walletManager.unlock(password);
        uiManager.showMainScreen();
        await uiManager.updateWalletDisplay();
        passwordInput.value = '';
    } catch (error) {
        uiManager.showInlineError('password-error', 'Invalid password');
        passwordInput.value = '';
    }
}

/**
 * Handle create wallet button click
 */
function handleCreateWallet() {
    uiManager.showModal('wallet-setup-modal');
    uiManager.showCreateWalletForm();
}

/**
 * Handle import wallet button click
 */
function handleImportWallet() {
    uiManager.showModal('wallet-setup-modal');
    uiManager.showImportWalletForm();
}

/**
 * Handle wallet generation
 */
async function handleGenerateWallet() {
    const passwordElement = document.getElementById('new-password');
    const confirmPasswordElement = document.getElementById('confirm-password');
    
    // Clear previous errors
    uiManager.clearError('password-create-error');
    
    const password = passwordElement ? passwordElement.value : '';
    const confirmPassword = confirmPasswordElement ? confirmPasswordElement.value : '';
    
    if (!password) {
        uiManager.showInlineError('password-create-error', 'Please enter a password');
        return;
    }
    
    if (password.length < 8) {
        uiManager.showInlineError('password-create-error', 'Password must be at least 8 characters long');
        return;
    }
    
    if (password !== confirmPassword) {
        uiManager.showInlineError('password-create-error', 'Passwords do not match');
        return;
    }
    
    try {
        const result = await walletManager.createWallet(password);
        
        if (!result.mnemonic) {
            uiManager.showInlineError('password-create-error', 'Failed to generate mnemonic');
            return;
        }
        
        uiManager.displaySeedPhrase(result.mnemonic);
        
    } catch (error) {
        uiManager.showInlineError('password-create-error', error.message);
    }
}

/**
 * Handle wallet import confirmation
 */
async function handleImportWalletConfirm() {
    const seedPhrase = document.getElementById('seed-phrase-input').value.trim();
    const password = document.getElementById('import-password').value;
    
    // Clear previous errors
    uiManager.clearError('import-error');
    
    if (!seedPhrase) {
        uiManager.showInlineError('import-error', 'Please enter your seed phrase');
        return;
    }
    
    if (!password) {
        uiManager.showInlineError('import-error', 'Please enter a password');
        return;
    }
    
    if (password.length < 8) {
        uiManager.showInlineError('import-error', 'Password must be at least 8 characters long');
        return;
    }
    
    try {
        await walletManager.importWallet(seedPhrase, password);
        uiManager.hideModal('wallet-setup-modal');
        uiManager.showMainScreen();
        await uiManager.updateWalletDisplay();
    } catch (error) {
        uiManager.showInlineError('import-error', error.message);
    }
}

/**
 * Handle seed phrase confirmation - show verification step
 */
async function handleSeedConfirmed() {
    uiManager.showSeedVerification();
}

/**
 * Handle seed phrase copy
 */
async function handleCopySeed() {
    if (uiManager.currentMnemonic) {
        try {
            await navigator.clipboard.writeText(uiManager.currentMnemonic);
            uiManager.showToast('Seed phrase copied to clipboard', 'success');
        } catch (error) {
            uiManager.showToast('Failed to copy seed phrase', 'error');
        }
    }
}

/**
 * Handle seed phrase download
 */
async function handleDownloadSeed() {
    if (uiManager.currentMnemonic) {
        const blob = new Blob([uiManager.currentMnemonic], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'qnet-wallet-seed-phrase.txt';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        uiManager.showToast('Seed phrase downloaded', 'success');
    }
}

/**
 * Handle seed phrase verification
 */
async function handleVerifySeed() {
    const isValid = uiManager.verifySeedPhrase();
    if (isValid) {
        // Verification passed, complete wallet setup
        uiManager.hideModal('wallet-setup-modal');
        uiManager.showMainScreen();
        await uiManager.updateWalletDisplay();
        uiManager.showToast('Wallet created successfully!', 'success');
    }
}

/**
 * Handle back to seed phrase
 */
async function handleBackToSeed() {
    uiManager.hideElement('seed-verification');
    uiManager.showElement('seed-phrase-display');
}

/**
 * Handle settings button click
 */
async function handleSettings() {
    await uiManager.loadSettings();
    uiManager.showModal('settings-modal');
    
    // Update connected sites count
    try {
        const sites = await walletManager.getConnectedSites();
        const countElement = document.getElementById('connected-sites-count');
        if (countElement) {
            countElement.textContent = `${sites.length} sites connected`;
        }
    } catch (error) {
        console.error('Failed to load connected sites count:', error);
    }
}

/**
 * Handle network change
 */
async function handleNetworkChange(network) {
    try {
        await walletManager.switchNetwork(network);
        await uiManager.updateWalletDisplay();
        uiManager.showToast(`Switched to ${network}`, 'success');
    } catch (error) {
        uiManager.showToast('Failed to switch network', 'error');
    }
}

/**
 * Handle password change
 */
async function handleChangePassword() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.cssText = `
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.7);
        backdrop-filter: blur(5px);
        z-index: 10000;
        display: flex;
        justify-content: center;
        align-items: center;
    `;
    
    modal.innerHTML = `
        <div class="modal-box">
            <div class="modal-header">
                <h3>Change Password</h3>
                <button id="close-password-modal">✕</button>
            </div>
            <div class="modal-content">
                <input type="password" id="current-password" placeholder="Current password" />
                <input type="password" id="new-password" placeholder="New password" />
                <input type="password" id="confirm-new-password" placeholder="Confirm new password" />
                <div id="password-change-error" class="inline-error hidden"></div>
                <div class="modal-actions">
                    <button id="cancel-password-change">Cancel</button>
                    <button id="confirm-password-change" class="primary">Change Password</button>
                </div>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Handle close
    modal.querySelector('#close-password-modal').onclick = () => modal.remove();
    modal.querySelector('#cancel-password-change').onclick = () => modal.remove();
    
    // Handle password change
    modal.querySelector('#confirm-password-change').onclick = async () => {
        const current = modal.querySelector('#current-password').value;
        const newPass = modal.querySelector('#new-password').value;
        const confirm = modal.querySelector('#confirm-new-password').value;
        
        if (newPass !== confirm) {
            const errorEl = modal.querySelector('#password-change-error');
            errorEl.textContent = 'New passwords do not match';
            errorEl.style.display = 'block';
            return;
        }
        
        try {
            await walletManager.changePassword(current, newPass);
            modal.remove();
            uiManager.showToast('Password changed successfully', 'success');
        } catch (error) {
            const errorEl = modal.querySelector('#password-change-error');
            errorEl.textContent = error.message;
            errorEl.style.display = 'block';
        }
    };
}

/**
 * Handle show seed phrase
 */
async function handleShowSeed() {
    const confirmed = await uiManager.showConfirmModal(
        'Show Seed Phrase',
        'Your seed phrase will be displayed. Make sure no one else can see your screen.'
    );
    
    if (confirmed) {
        try {
            const mnemonic = await walletManager.getSeedPhrase();
            
            const modal = document.createElement('div');
            modal.className = 'modal-overlay';
            modal.innerHTML = `
                <div class="modal-box">
                    <div class="modal-header">
                        <h3>🔑 Your Seed Phrase</h3>
                        <button id="close-seed-modal">✕</button>
                    </div>
                    <div class="seed-phrase-display">
                        <div class="seed-phrase-grid">
                            ${mnemonic.split(' ').map((word, index) => `
                                <div class="seed-word">
                                    <span class="word-number">${index + 1}</span>
                                    <span class="word-text">${word}</span>
                                </div>
                            `).join('')}
                        </div>
                        <div class="seed-actions">
                            <button id="copy-displayed-seed">📋 Copy</button>
                        </div>
                        <div class="seed-warning">
                            <p>⚠️ Keep your seed phrase secret and secure!</p>
                        </div>
                    </div>
                </div>
            `;
            
            document.body.appendChild(modal);
            
            modal.querySelector('#close-seed-modal').onclick = () => modal.remove();
            modal.querySelector('#copy-displayed-seed').onclick = async () => {
                await navigator.clipboard.writeText(mnemonic);
                uiManager.showToast('Seed phrase copied', 'success');
            };
            
        } catch (error) {
            uiManager.showToast('Failed to retrieve seed phrase', 'error');
        }
    }
}

/**
 * Handle export private key
 */
async function handleExportPrivateKey() {
    const confirmed = await uiManager.showConfirmModal(
        'Export Private Key',
        'This will reveal your private key. Only do this if you know what you are doing.'
    );
    
    if (confirmed) {
        try {
            const privateKey = await walletManager.getPrivateKey();
            
            const modal = document.createElement('div');
            modal.className = 'modal-overlay';
            modal.innerHTML = `
                <div class="modal-box">
                    <div class="modal-header">
                        <h3>🔐 Private Key</h3>
                        <button id="close-key-modal">✕</button>
                    </div>
                    <div class="private-key-display">
                        <textarea readonly class="private-key-display">${privateKey}</textarea>
                        <button id="copy-private-key">📋 Copy Private Key</button>
                        <div class="key-warning">
                            <p>⚠️ Never share your private key with anyone!</p>
                        </div>
                    </div>
                </div>
            `;
            
            document.body.appendChild(modal);
            
            modal.querySelector('#close-key-modal').onclick = () => modal.remove();
            modal.querySelector('#copy-private-key').onclick = async () => {
                await navigator.clipboard.writeText(privateKey);
                uiManager.showToast('Private key copied', 'success');
            };
            
        } catch (error) {
            uiManager.showToast('Failed to export private key', 'error');
        }
    }
}

/**
 * Handle reset wallet
 */
async function handleResetWallet() {
    const confirmed = await uiManager.showConfirmModal(
        'Reset Wallet',
        'This will permanently delete your wallet and all accounts. Make sure you have backed up your seed phrase. This action cannot be undone.'
    );
    
    if (confirmed) {
        const doubleConfirmed = await uiManager.showConfirmModal(
            'Final Confirmation',
            'Type "RESET" to confirm wallet deletion'
        );
        
        if (doubleConfirmed) {
            try {
                await walletManager.resetWallet();
                uiManager.hideModal('settings-modal');
                uiManager.showLockedScreen();
                uiManager.showToast('Wallet has been reset', 'success');
            } catch (error) {
                uiManager.showToast('Failed to reset wallet', 'error');
            }
        }
    }
}

/**
 * Handle clear data
 */
async function handleClearData() {
    const confirmed = await uiManager.showConfirmModal(
        'Clear All Data',
        'This will clear all application data including settings and connected sites, but keep your wallet.'
    );
    
    if (confirmed) {
        try {
            await walletManager.clearApplicationData();
            uiManager.showToast('Application data cleared', 'success');
            // Reload settings
            await uiManager.loadSettings();
        } catch (error) {
            uiManager.showToast('Failed to clear data', 'error');
        }
    }
}

/**
 * Handle activation code generation (Browser Extension - Code Only)
 * Browser extensions can only generate activation codes, NOT activate full nodes
 * Full/Super nodes must be activated on servers directly
 */
async function handleGetActivationCode() {
    try {
        const nodeType = prompt('Select node type (light/full/super):', 'light');
        if (!nodeType || !['light', 'full', 'super'].includes(nodeType)) {
            uiManager.showToast('Invalid node type', 'error');
            return;
        }

        // Phase 1: Generate 1DEV burn transaction for activation code
        if (await walletManager.getCurrentPhase() === 1) {
            const burnAmount = await walletManager.getActivationCost(nodeType);
            const burnResult = await walletManager.burn1DEVForCode(nodeType, burnAmount);
            
            uiManager.showModal('activation-code-modal');
            document.getElementById('activation-code-display').textContent = burnResult.activationCode;
            
            uiManager.showToast(
                `Activation code generated! Use this code on a server to activate your ${nodeType} node.`,
                'success'
            );
        } 
        // Phase 2: Generate QNC transfer code
        else {
            const qncAmount = await walletManager.getQNCActivationCost(nodeType);
            const transferResult = await walletManager.generateQNCTransferCode(nodeType, qncAmount);
            
            uiManager.showModal('activation-code-modal');
            document.getElementById('activation-code-display').textContent = transferResult.activationCode;
            
            uiManager.showToast(
                `QNC transfer code generated! Complete activation on a server.`,
                'success'
            );
        }
        
    } catch (error) {
        uiManager.showToast('Failed to generate activation code: ' + error.message, 'error');
    }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', initialize);

// Export for testing
if (typeof window !== 'undefined') {
    window.QNetWallet = {
        walletManager: () => walletManager,
        uiManager: () => uiManager,
        solanaConnection: () => solanaConnection
    };
}
