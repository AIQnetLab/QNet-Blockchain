/**
 * QNet Wallet Background Service Worker - Production Version
 * Handles background operations, notifications, and wallet state management
 */

// Service worker event handlers
chrome.runtime.onInstalled.addListener((details) => {
    console.log('QNet Wallet installed:', details.reason);
    
    if (details.reason === 'install') {
        // Set up initial state
        chrome.storage.local.set({
            'qnet_wallet_installed': true,
            'qnet_wallet_version': '1.0.0',
            'qnet_install_timestamp': Date.now()
        });
        
        // Show welcome notification
        chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon-48.png',
            title: 'QNet Wallet Installed',
            message: 'Welcome to QNet! Click the extension icon to get started.'
        });
    }
});

// Handle extension startup
chrome.runtime.onStartup.addListener(() => {
    console.log('QNet Wallet starting up...');
    initializeBackgroundServices();
});

// ---------------------------------------------------------------------------
// v14.5: SENDER IDENTITY VALIDATION (defense-in-depth)
// ---------------------------------------------------------------------------
// chrome.runtime.onMessage fires for messages from our own extension pages
// (popup, content scripts). The manifest does NOT declare
// `externally_connectable`, so web pages cannot reach this listener
// directly — but we enforce `sender.id === chrome.runtime.id` to make that
// guarantee explicit and defensive against future manifest misconfiguration.
//
// Sensitive mutation messages (WALLET_UNLOCKED, WALLET_LOCKED, NODE_ACTIVATED,
// TRANSACTION_CONFIRMED) can ONLY originate from privileged extension UIs
// (popup / setup). If they ever arrive from a content script embedded on an
// arbitrary web page (`sender.tab` is set), we reject them — a random
// website must not be able to flip the wallet into "unlocked" state.
// ---------------------------------------------------------------------------
const SENSITIVE_MESSAGE_TYPES = new Set([
    'WALLET_UNLOCKED',
    'WALLET_LOCKED',
    'NODE_ACTIVATED',
    'TRANSACTION_CONFIRMED',
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Background received message:', message);

    // v14.5: Only our own extension may send messages here.
    if (!sender || sender.id !== chrome.runtime.id) {
        console.warn('[QNET][WARN] rejected_message reason=foreign_sender id=' + (sender && sender.id));
        return;
    }

    // v14.5: Sensitive state mutations must not come from a content-script
    // context (i.e. a web page). Only popup/setup/background UIs qualify.
    if (SENSITIVE_MESSAGE_TYPES.has(message && message.type) && sender.tab) {
        console.warn('[QNET][WARN] rejected_sensitive_msg type=' + message.type + ' reason=tab_origin url=' + (sender.url || ''));
        return;
    }

    switch (message.type) {
        case 'GET_WALLET_STATE':
            handleGetWalletState(sendResponse);
            return true; // Keep channel open for async response

        case 'WALLET_UNLOCKED':
            handleWalletUnlocked(message.data);
            break;

        case 'WALLET_LOCKED':
            handleWalletLocked();
            break;

        case 'NODE_ACTIVATED':
            handleNodeActivated(message.data);
            break;

        case 'TRANSACTION_CONFIRMED':
            handleTransactionConfirmed(message.data);
            break;

        default:
            console.warn('Unknown message type:', message.type);
    }
});

// Handle alarm events for periodic tasks
chrome.alarms.onAlarm.addListener((alarm) => {
    console.log('Alarm triggered:', alarm.name);
    
    switch (alarm.name) {
        case 'wallet_health_check':
            performWalletHealthCheck();
            break;
            
        case 'price_update':
            updateActivationPrices();
            break;
            
        case 'backup_reminder':
            showBackupReminder();
            break;
    }
});

/**
 * Initialize background services
 */
async function initializeBackgroundServices() {
    try {
        // Set up periodic alarms
        chrome.alarms.create('wallet_health_check', { periodInMinutes: 60 });
        chrome.alarms.create('price_update', { periodInMinutes: 30 });
        chrome.alarms.create('backup_reminder', { periodInMinutes: 1440 }); // Daily
        
        console.log('✅ Background services initialized');
    } catch (error) {
        console.error('❌ Failed to initialize background services:', error);
    }
}

/**
 * Handle wallet state requests
 */
async function handleGetWalletState(sendResponse) {
    try {
        const walletData = await chrome.storage.local.get([
            'qnet_wallet_data',
            'qnet_wallet_unlocked',
            'qnet_activations'
        ]);
        
        const state = {
            hasWallet: !!walletData.qnet_wallet_data,
            isUnlocked: !!walletData.qnet_wallet_unlocked,
            activationCount: walletData.qnet_activations ? 
                Object.keys(walletData.qnet_activations).length : 0
        };
        
        sendResponse({ success: true, state });
    } catch (error) {
        console.error('Error getting wallet state:', error);
        sendResponse({ success: false, error: error.message });
    }
}

/**
 * Handle wallet unlock event
 */
async function handleWalletUnlocked(data) {
    try {
        // Store unlock state
        await chrome.storage.local.set({
            'qnet_wallet_unlocked': true,
            'qnet_last_unlock': Date.now()
        });
        
        // Update badge
        chrome.action.setBadgeText({ text: '✓' });
        chrome.action.setBadgeBackgroundColor({ color: '#00ff00' });
        
        console.log('✅ Wallet unlocked');
    } catch (error) {
        console.error('Error handling wallet unlock:', error);
    }
}

/**
 * Handle wallet lock event
 */
async function handleWalletLocked() {
    try {
        // Clear unlock state
        await chrome.storage.local.remove(['qnet_wallet_unlocked']);
        
        // Update badge
        chrome.action.setBadgeText({ text: '🔒' });
        chrome.action.setBadgeBackgroundColor({ color: '#ff0000' });
        
        console.log('🔒 Wallet locked');
    } catch (error) {
        console.error('Error handling wallet lock:', error);
    }
}

/**
 * Handle node activation event
 */
async function handleNodeActivated(data) {
    try {
        const { activationCode, burnTxHash, burnAmount } = data;
        
        // Show success notification
        chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon-48.png',
            title: '🎉 Node Activated!',
            message: `Successfully activated QNet node for ${burnAmount} 1DEV tokens.\nActivation Code: ${activationCode}`
        });
        
        // Update badge with activation count
        const activations = await chrome.storage.local.get(['qnet_activations']);
        const count = activations.qnet_activations ? 
            Object.keys(activations.qnet_activations).length : 0;
        
        chrome.action.setBadgeText({ text: count.toString() });
        chrome.action.setBadgeBackgroundColor({ color: '#9333ea' });
        
        console.log('✅ Node activation processed:', activationCode);
    } catch (error) {
        console.error('Error handling node activation:', error);
    }
}

/**
 * Handle transaction confirmation
 */
async function handleTransactionConfirmed(data) {
    try {
        const { txHash, type, amount } = data;
        
        // Show transaction notification
        chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon-48.png',
            title: 'Transaction Confirmed',
            message: `${type} transaction confirmed: ${amount} tokens\nTX: ${txHash.slice(0, 12)}...`
        });
        
        console.log('✅ Transaction confirmed:', txHash);
    } catch (error) {
        console.error('Error handling transaction confirmation:', error);
    }
}

/**
 * Perform periodic wallet health check
 */
async function performWalletHealthCheck() {
    try {
        const walletData = await chrome.storage.local.get([
            'qnet_wallet_data',
            'qnet_last_unlock'
        ]);
        
        if (!walletData.qnet_wallet_data) return;
        
        // Check if wallet has been unlocked recently
        const lastUnlock = walletData.qnet_last_unlock || 0;
        const hoursSinceUnlock = (Date.now() - lastUnlock) / (1000 * 60 * 60);
        
        if (hoursSinceUnlock > 24) {
            // Auto-lock wallet after 24 hours of inactivity
            await chrome.storage.local.remove(['qnet_wallet_unlocked']);
            chrome.action.setBadgeText({ text: '🔒' });
            chrome.action.setBadgeBackgroundColor({ color: '#ff0000' });
        }
        
        console.log('✅ Wallet health check completed');
    } catch (error) {
        console.error('Error in wallet health check:', error);
    }
}

/**
 * Update activation prices from blockchain
 */
async function updateActivationPrices() {
    try {
        // In production, this would fetch real burn progress from blockchain
        // For now, store timestamp of last update
        await chrome.storage.local.set({
            'qnet_last_price_update': Date.now()
        });
        
        console.log('✅ Activation prices updated');
    } catch (error) {
        console.error('Error updating activation prices:', error);
    }
}

/**
 * Show backup reminder notification
 */
async function showBackupReminder() {
    try {
        const walletData = await chrome.storage.local.get([
            'qnet_wallet_data',
            'qnet_last_backup_reminder'
        ]);
        
        if (!walletData.qnet_wallet_data) return;
        
        const lastReminder = walletData.qnet_last_backup_reminder || 0;
        const daysSinceReminder = (Date.now() - lastReminder) / (1000 * 60 * 60 * 24);
        
        if (daysSinceReminder >= 7) {
            chrome.notifications.create({
                type: 'basic',
                iconUrl: 'icons/icon-48.png',
                title: '💾 Backup Reminder',
                message: 'Remember to keep your seed phrase safe and backed up!'
            });
            
            await chrome.storage.local.set({
                'qnet_last_backup_reminder': Date.now()
            });
        }
        
        console.log('✅ Backup reminder check completed');
    } catch (error) {
        console.error('Error in backup reminder:', error);
    }
}

// Initialize background services when script loads
initializeBackgroundServices();
