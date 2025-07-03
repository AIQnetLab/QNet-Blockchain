/**
 * QNet Wallet Simple Version - Minimal Functionality Test
 */

console.log('🟢 Simple QNet Wallet starting...');

// Global state
let walletExists = false;
let isUnlocked = false;

// Check if we're in extension context
if (window.location.protocol === 'chrome-extension:') {
    console.log('✅ Running in extension context');
    
    // Execute wallet code only in extension context
    (function() {
        'use strict';

// Simple functions
function showScreen(screenId) {
    console.log('📱 Showing screen:', screenId);
    
    // Hide all screens
    document.querySelectorAll('.screen, .loading-screen').forEach(screen => {
        screen.classList.add('hidden');
        screen.style.display = 'none';
    });
    
    // Show target screen
    const screen = document.getElementById(screenId);
    if (screen) {
        screen.classList.remove('hidden');
        screen.style.display = 'block';
        console.log('✅ Screen shown:', screenId);
    } else {
        console.error('❌ Screen not found:', screenId);
    }
}

function showToast(message, type = 'info') {
    console.log(`📝 Toast (${type}):`, message);
    
    // Remove existing toasts
    document.querySelectorAll('.toast-notification').forEach(toast => toast.remove());
    
    // Create new toast
    const toast = document.createElement('div');
    toast.className = `toast-notification toast-${type}`;
    toast.textContent = message;
    toast.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${type === 'error' ? '#ef4444' : type === 'success' ? '#10b981' : '#3b82f6'};
        color: white;
        padding: 12px 20px;
        border-radius: 8px;
        z-index: 10000;
        font-size: 14px;
        max-width: 300px;
        word-wrap: break-word;
    `;
    
    document.body.appendChild(toast);
    
    // Auto remove after 3 seconds
    setTimeout(() => toast.remove(), 3000);
}

// Check wallet state
async function checkWalletState() {
    console.log('🔍 Checking wallet state...');
    
    // Check localStorage
    const storedState = localStorage.getItem('qnet_wallet_state');
    if (storedState) {
        try {
            const state = JSON.parse(storedState);
            walletExists = state.walletExists || false;
            isUnlocked = state.isUnlocked || false;
            console.log('✅ Wallet state:', { walletExists, isUnlocked });
        } catch (error) {
            console.error('❌ Failed to parse wallet state:', error);
        }
    }
    
    // Try background script
    try {
        if (typeof chrome !== 'undefined' && chrome.runtime) {
            console.log('📡 Checking background script...');
            const response = await chrome.runtime.sendMessage({ type: 'GET_WALLET_STATE' });
            if (response && response.success) {
                walletExists = response.walletExists || false;
                isUnlocked = response.isUnlocked || false;
                console.log('✅ Background state:', response);
            } else {
                console.log('⚠️ Background script not ready or no response');
            }
        }
    } catch (error) {
        console.log('⚠️ Background script error (normal on first load):', error.message);
    }
}

// Setup basic interface
function setupInterface() {
    console.log('🎨 Setting up interface...');
    
    if (!walletExists) {
        // Show setup screen
        console.log('👋 No wallet - showing setup');
        showScreen('locked-screen');
        
        // Show setup options
        const setupOptions = document.querySelector('.setup-options');
        if (setupOptions) {
            setupOptions.style.display = 'flex';
        }
        
        // Setup create wallet button
        const createBtn = document.getElementById('create-wallet-button');
        if (createBtn) {
            createBtn.addEventListener('click', () => {
                showToast('Wallet creation coming soon! Please use setup process.', 'info');
                
                // Simulate wallet creation
                setTimeout(() => {
                    localStorage.setItem('qnet_wallet_state', JSON.stringify({
                        walletExists: true,
                        isUnlocked: false
                    }));
                    showToast('Demo wallet created! Please reload extension.', 'success');
                }, 1000);
            });
            console.log('✅ Create wallet button setup');
        }
        
        // Setup import wallet button
        const importBtn = document.getElementById('import-wallet-button');
        if (importBtn) {
            importBtn.addEventListener('click', () => {
                showToast('Wallet import coming soon! Please use setup process.', 'info');
            });
            console.log('✅ Import wallet button setup');
        }
        
    } else if (!isUnlocked) {
        // Show locked screen
        console.log('🔒 Wallet exists but locked');
        showScreen('locked-screen');
        
        // Setup unlock button
        const unlockBtn = document.getElementById('unlock-button');
        if (unlockBtn) {
            unlockBtn.addEventListener('click', () => {
                const passwordInput = document.getElementById('password-input');
                const password = passwordInput?.value;
                
                if (!password) {
                    showToast('Please enter password', 'error');
                    return;
                }
                
                showToast('Password validation coming soon! Demo unlock...', 'info');
                
                // Simulate unlock
                setTimeout(() => {
                    isUnlocked = true;
                    localStorage.setItem('qnet_wallet_state', JSON.stringify({
                        walletExists: true,
                        isUnlocked: true
                    }));
                    showMainInterface();
                    showToast('Demo wallet unlocked!', 'success');
                }, 1000);
            });
            console.log('✅ Unlock button setup');
        }
        
    } else {
        // Show main interface
        console.log('🚀 Wallet ready - showing main interface');
        showMainInterface();
    }
}

// Show main wallet interface
function showMainInterface() {
    console.log('💎 Showing main wallet interface');
    showScreen('main-wallet-screen');
    
    // Update interface elements
    const addressElement = document.getElementById('account-address');
    if (addressElement) {
        addressElement.textContent = '7a9bk4f2eon8x3m5z1c7demo';
        addressElement.addEventListener('click', () => {
            navigator.clipboard.writeText('7a9bk4f2eon8x3m5z1c7demo');
            showToast('Demo address copied!', 'success');
        });
    }
    
    // Setup copy address button
    const copyAddressBtn = document.getElementById('copy-address-btn');
    if (copyAddressBtn) {
        copyAddressBtn.addEventListener('click', () => {
            navigator.clipboard.writeText('7a9bk4f2eon8x3m5z1c7demo');
            showToast('Demo address copied!', 'success');
        });
    }
    
    // Setup receive modal controls
    const closeReceiveBtn = document.getElementById('close-receive-modal');
    if (closeReceiveBtn) {
        closeReceiveBtn.addEventListener('click', () => {
            const modal = document.getElementById('receive-modal');
            if (modal) modal.classList.add('hidden');
        });
    }
    
    const copyReceiveBtn = document.getElementById('copy-receive-address-btn');
    if (copyReceiveBtn) {
        copyReceiveBtn.addEventListener('click', () => {
            const addressElement = document.getElementById('receive-address');
            const address = addressElement?.textContent;
            
            if (address && address !== 'Loading...') {
                navigator.clipboard.writeText(address);
                showToast('Address copied to clipboard', 'success');
            } else {
                showToast('No address to copy', 'error');
            }
        });
    }
    
    const balanceElement = document.getElementById('total-balance');
    if (balanceElement) {
        balanceElement.textContent = '0.00 QNC';
    }
    
    const networkBalance = document.getElementById('network-balance');
    if (networkBalance) {
        networkBalance.textContent = '0 QNC (Demo)';
    }
    
    // Setup action buttons
    const sendBtn = document.getElementById('send-button');
    if (sendBtn) {
        sendBtn.addEventListener('click', () => showToast('Send feature in development', 'info'));
    }
    
    const receiveBtn = document.getElementById('receive-button');
    if (receiveBtn) {
        receiveBtn.addEventListener('click', () => showToast('Receive feature in development', 'info'));
    }
    
    const swapBtn = document.getElementById('swap-button');
    if (swapBtn) {
        swapBtn.addEventListener('click', () => showToast('Bridge feature in development', 'info'));
    }
    
    // Setup lock button
    const lockBtn = document.getElementById('lock-wallet-btn');
    if (lockBtn) {
        lockBtn.addEventListener('click', () => {
            isUnlocked = false;
            localStorage.setItem('qnet_wallet_state', JSON.stringify({
                walletExists: true,
                isUnlocked: false
            }));
            showScreen('locked-screen');
            showToast('Wallet locked', 'success');
        });
    }
    
    console.log('✅ Main interface setup complete');
}

// Main initialization
async function initSimpleWallet() {
    console.log('🚀 Starting simple wallet initialization...');
    
    try {
        // Hide loading screen initially
        showScreen('loading-screen');
        
        // Basic DOM check
        const requiredElements = [
            'loading-screen',
            'locked-screen', 
            'main-wallet-screen',
            'account-address',
            'unlock-button'
        ];
        
        let missingElements = [];
        requiredElements.forEach(id => {
            if (!document.getElementById(id)) {
                missingElements.push(id);
            }
        });
        
        if (missingElements.length > 0) {
            throw new Error(`Missing DOM elements: ${missingElements.join(', ')}`);
        }
        
        console.log('✅ All required DOM elements found');
        
        // Check wallet state
        await checkWalletState();
        
        // Setup interface
        setupInterface();
        
        console.log('🎉 Simple wallet initialization complete!');
        
    } catch (error) {
        console.error('❌ Simple wallet initialization failed:', error);
        
        const loadingScreen = document.getElementById('loading-screen');
        if (loadingScreen) {
            loadingScreen.innerHTML = `
                <div class="loading-container">
                    <div style="font-size: 48px; margin-bottom: 20px; color: #ef4444;">❌</div>
                    <h2>Simple Wallet Error</h2>
                    <p style="color: #ef4444; margin: 20px 0;">${error.message}</p>
                    <button id="reload-button" style="
                        background: #3b82f6;
                        color: white;
                        border: none;
                        padding: 12px 24px;
                        border-radius: 8px;
                        cursor: pointer;
                        font-size: 14px;
                    ">🔄 Reload</button>
                </div>
            `;
            
            // Add event listener for reload button
            setTimeout(() => {
                const reloadBtn = document.getElementById('reload-button');
                if (reloadBtn) {
                    reloadBtn.addEventListener('click', () => window.location.reload());
                }
            }, 100);
        }
    }
}

// Initialize when DOM loads
document.addEventListener('DOMContentLoaded', () => {
    console.log('📱 DOM loaded - starting simple wallet');
    initSimpleWallet();
});

console.log('🟢 Simple QNet Wallet script loaded');
    
    })(); // Close IIFE
} else {
    console.log('❌ Not running in extension context');
} 