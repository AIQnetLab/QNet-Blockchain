// QNet Wallet Background Service Worker - Simplified Version

// State management
let isUnlocked = false;
let unlockTimeout = null;
let walletData = {
    accounts: [],
    activeAccountId: null,
    network: 'QNet Mainnet'
};

// Auto-lock after 15 minutes
const AUTO_LOCK_TIME = 15 * 60 * 1000;

// Message handler
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    handleMessage(request, sender, sendResponse);
    return true; // Keep message channel open for async response
});

async function handleMessage(request, sender, sendResponse) {
    try {
        switch (request.action) {
            case 'unlock':
                // Simplified unlock - in production would verify password
                isUnlocked = true;
                resetAutoLock();
                sendResponse({ success: true });
                break;
                
            case 'lock':
                isUnlocked = false;
                clearTimeout(unlockTimeout);
                sendResponse({ success: true });
                break;
                
            case 'getWalletData':
                if (!isUnlocked) {
                    sendResponse({ success: false, error: 'Wallet locked' });
                    return;
                }
                const data = await getWalletData();
                sendResponse({ success: true, data });
                break;
                
            case 'createWallet':
                // Simplified wallet creation
                const newWallet = {
                    id: Date.now(),
                    name: 'Account 1',
                    address: 'qnet1' + Math.random().toString(36).substring(2, 15),
                    solanaAddress: generateSolanaAddress()
                };
                walletData.accounts.push(newWallet);
                walletData.activeAccountId = newWallet.id;
                sendResponse({ success: true, data: newWallet });
                break;
                
            case 'sendTransaction':
                if (!isUnlocked) {
                    sendResponse({ success: false, error: 'Wallet locked' });
                    return;
                }
                
                // Validate basic inputs
                if (!request.to || !request.amount) {
                    sendResponse({ success: false, error: 'Invalid transaction parameters' });
                    return;
                }
                
                // Simulate transaction
                const txHash = '0x' + Math.random().toString(16).substring(2, 66);
                console.log('Simulated transaction sent:', txHash);
                sendResponse({ success: true, txHash });
                break;
                
            case 'activateNode':
                if (!isUnlocked) {
                    sendResponse({ success: false, error: 'Wallet locked' });
                    return;
                }
                
                // Simulate node activation
                const nodeId = 'node_' + Math.random().toString(36).substring(2, 10);
                console.log('Node activated:', nodeId);
                sendResponse({ success: true, nodeId });
                break;
                
            case 'getNodeStatus':
                const nodeStatus = {
                    active: Math.random() > 0.5,
                    type: 'full',
                    rewards: Math.floor(Math.random() * 1000)
                };
                sendResponse({ success: true, data: nodeStatus });
                break;
                
            case 'openPage':
                chrome.tabs.create({
                    url: chrome.runtime.getURL(request.page)
                });
                sendResponse({ success: true });
                break;
                
            case 'dappRequest':
                const dappResponse = await handleDappRequest(request, sender);
                sendResponse(dappResponse);
                break;
                
            case 'checkConnection':
                const isConnected = await checkDappConnection(request.origin);
                sendResponse({ connected: isConnected });
                break;
                
            default:
                sendResponse({ success: false, error: 'Unknown action' });
        }
    } catch (error) {
        console.error('Error handling message:', error);
        sendResponse({ success: false, error: error.message });
    }
}

// Handle DApp requests
async function handleDappRequest(request, sender) {
    try {
        const origin = new URL(sender.tab.url).origin;
        const isConnected = await checkDappConnection(origin);
        
        switch (request.method) {
            case 'qnet_requestAccounts':
                if (!isUnlocked) {
                    return { result: [] };
                }
                
                // Return current account address
                const activeAccount = getActiveAccount();
                if (activeAccount) {
                    // Store connection
                    await storeConnection(origin);
                    return { result: [activeAccount.address] };
                }
                return { result: [] };
                
            case 'qnet_sendTransaction':
                if (!isUnlocked) {
                    return { error: { code: -32000, message: 'Wallet locked' } };
                }
                
                if (!isConnected) {
                    return { error: { code: -32000, message: 'Not connected' } };
                }
                
                const tx = request.params[0];
                if (!tx || !tx.to) {
                    return { error: { code: -32602, message: 'Invalid transaction parameters' } };
                }
                
                // Show confirmation popup (simplified)
                const approved = await showTransactionPopup(tx, origin);
                if (!approved) {
                    return { error: { code: 4001, message: 'User rejected transaction' } };
                }
                
                // Simulate transaction
                const txHash = '0x' + Math.random().toString(16).substring(2, 66);
                return { result: txHash };
                
            default:
                return { error: { code: -32601, message: 'Method not found' } };
        }
    } catch (error) {
        return { error: { code: -32603, message: error.message } };
    }
}

// Generate a mock Solana address
function generateSolanaAddress() {
    const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let result = '';
    for (let i = 0; i < 44; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// Check if DApp is connected
async function checkDappConnection(origin) {
    return new Promise((resolve) => {
        chrome.storage.local.get(['connectedSites'], (result) => {
            const connectedSites = result.connectedSites || [];
            resolve(connectedSites.includes(origin));
        });
    });
}

// Store DApp connection
async function storeConnection(origin) {
    return new Promise((resolve) => {
        chrome.storage.local.get(['connectedSites'], (result) => {
            const connectedSites = result.connectedSites || [];
            if (!connectedSites.includes(origin)) {
                connectedSites.push(origin);
                chrome.storage.local.set({ connectedSites }, resolve);
            } else {
                resolve();
            }
        });
    });
}

// Get comprehensive wallet data
async function getWalletData() {
    const activeAccount = getActiveAccount();
    if (!activeAccount) {
        return null;
    }
    
    return {
        address: activeAccount.address,
        solanaAddress: activeAccount.solanaAddress,
        balance: {
            qnc: Math.random() * 10000,
            oneDev: Math.random() * 2000
        },
        transactions: [],
        nodeStatus: {
            active: Math.random() > 0.5,
            type: 'full'
        }
    };
}

// Get active account
function getActiveAccount() {
    return walletData.accounts.find(acc => acc.id === walletData.activeAccountId);
}

// Show transaction confirmation popup
async function showTransactionPopup(tx, origin) {
    return new Promise((resolve) => {
        // For now, auto-approve (in production, would show actual popup)
        console.log('Transaction approval requested:', tx, 'from', origin);
        resolve(true);
    });
}

// Reset auto-lock timer
function resetAutoLock() {
    clearTimeout(unlockTimeout);
    unlockTimeout = setTimeout(() => {
        isUnlocked = false;
    }, AUTO_LOCK_TIME);
}

// Handle extension installation
chrome.runtime.onInstalled.addListener(async (details) => {
    if (details.reason === 'install') {
        // Initialize default account
        const defaultAccount = {
            id: 1,
            name: 'Account 1',
            address: 'qnet1' + Math.random().toString(36).substring(2, 15),
            solanaAddress: generateSolanaAddress()
        };
        
        walletData.accounts.push(defaultAccount);
        walletData.activeAccountId = defaultAccount.id;
        
        // Store in chrome.storage
        chrome.storage.local.set({ walletData });
        
        console.log('QNet Wallet installed successfully');
    }
});

// Load wallet data on startup
chrome.storage.local.get(['walletData'], (result) => {
    if (result.walletData) {
        walletData = result.walletData;
    }
});

// Handle periodic tasks
chrome.alarms.create('updateBalances', { periodInMinutes: 5 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'updateBalances' && isUnlocked) {
        // Update wallet data periodically
        const data = await getWalletData();
        
        // Notify popup if open
        chrome.runtime.sendMessage({
            action: 'walletDataUpdate',
            data
        }).catch(() => {
            // Popup not open, ignore
        });
    }
});

console.log('QNet Wallet service worker initialized'); 