// QNet Wallet Background Service Worker

import { WalletManager } from './src/wallet/WalletManager.js';
import { NodeManager } from './src/node/NodeManager.js';
import { NetworkManager } from './src/network/NetworkManager.js';
import { StorageManager } from './src/storage/StorageManager.js';
import { PhishingDetector } from './src/security/PhishingDetector.js';
import { RateLimiter } from './src/security/RateLimiter.js';
import { ReplayProtection } from './src/security/ReplayProtection.js';
import { TransactionAuditor } from './src/security/TransactionAuditor.js';

// Initialize managers
const walletManager = new WalletManager();
const nodeManager = new NodeManager();
const networkManager = new NetworkManager();
const storageManager = new StorageManager();
const phishingDetector = new PhishingDetector();
const rateLimiter = new RateLimiter();
const replayProtection = new ReplayProtection();
const transactionAuditor = new TransactionAuditor();

// State
let isUnlocked = false;
let unlockTimeout = null;

// Auto-lock after 15 minutes
const AUTO_LOCK_TIME = 15 * 60 * 1000;

// Message handler
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    handleMessage(request, sender, sendResponse);
    return true; // Keep message channel open for async response
});

async function handleMessage(request, sender, sendResponse) {
    try {
        // Check rate limits only for API-heavy actions
        if (shouldRateLimit(request.action)) {
            const identifier = sender.tab?.id || 'extension';
            const limits = RateLimiter.getLimits(request.action);
            if (limits) {
                await rateLimiter.checkLimit(request.action, identifier, limits);
            }
        }
        
        switch (request.action) {
            case 'unlock':
                const unlocked = await walletManager.unlock(request.password);
                if (unlocked) {
                    isUnlocked = true;
                    resetAutoLock();
                }
                sendResponse({ success: unlocked });
                break;
                
            case 'lock':
                await walletManager.lock();
                isUnlocked = false;
                clearTimeout(unlockTimeout);
                sendResponse({ success: true });
                break;
                
            case 'getWalletData':
                if (!isUnlocked) {
                    sendResponse({ success: false, error: 'Wallet locked' });
                    return;
                }
                const walletData = await getWalletData();
                sendResponse({ success: true, data: walletData });
                break;
                
            case 'createWallet':
                const wallet = await walletManager.createWallet(request.password);
                sendResponse({ success: true, data: wallet });
                break;
                
            case 'importWallet':
                const imported = await walletManager.importWallet(
                    request.seedPhrase,
                    request.password
                );
                sendResponse({ success: true, data: imported });
                break;
                
            case 'sendTransaction':
                if (!isUnlocked) {
                    sendResponse({ success: false, error: 'Wallet locked' });
                    return;
                }
                
                // Validate inputs
                if (!walletManager.crypto.validateAddress(request.to)) {
                    sendResponse({ success: false, error: 'Invalid recipient address' });
                    return;
                }
                
                if (!walletManager.crypto.validateAmount(request.amount)) {
                    sendResponse({ success: false, error: 'Invalid amount' });
                    return;
                }
                
                if (!walletManager.crypto.validateMemo(request.memo)) {
                    sendResponse({ success: false, error: 'Invalid memo (max 256 chars)' });
                    return;
                }
                
                // Get transaction history and balance for audit
                const currentAddress = walletManager.getCurrentAddress();
                const txHistory = await networkManager.getTransactions(currentAddress);
                const balance = await networkManager.getBalance(currentAddress);
                
                // Create transaction object
                const tx = {
                    from: currentAddress,
                    to: request.to,
                    amount: request.amount,
                    memo: request.memo,
                    timestamp: Date.now(),
                    nonce: await networkManager.getNonce(currentAddress)
                };
                
                // Add replay protection
                const protectedTx = replayProtection.addChainProtection(tx);
                
                // Audit transaction
                const auditResult = await transactionAuditor.auditTransaction(
                    protectedTx,
                    txHistory,
                    balance
                );
                
                // Check if should block
                if (transactionAuditor.shouldBlockTransaction(auditResult)) {
                    sendResponse({ 
                        success: false, 
                        error: 'Transaction blocked due to suspicious activity',
                        audit: auditResult
                    });
                    return;
                }
                
                // Show warning for high risk transactions
                if (auditResult.riskLevel === 'high' || auditResult.riskLevel === 'critical') {
                    const userConfirmed = await showRiskWarning(auditResult);
                    if (!userConfirmed) {
                        sendResponse({ 
                            success: false, 
                            error: 'Transaction cancelled by user',
                            audit: auditResult
                        });
                        return;
                    }
                }
                
                const txHash = await walletManager.sendTransaction(
                    request.to,
                    request.amount,
                    request.memo
                );
                sendResponse({ success: true, txHash, audit: auditResult });
                break;
                
            case 'activateNode':
                if (!isUnlocked) {
                    sendResponse({ success: false, error: 'Wallet locked' });
                    return;
                }
                const nodeId = await nodeManager.activateNode(
                    request.nodeType,
                    walletManager.getCurrentAddress(),
                    request.burnTxHash
                );
                sendResponse({ success: true, nodeId });
                break;
                
            case 'getNodeStatus':
                const nodeStatus = await nodeManager.getNodeStatus();
                sendResponse({ success: true, data: nodeStatus });
                break;
                
            case 'claimRewards':
                if (!isUnlocked) {
                    sendResponse({ success: false, error: 'Wallet locked' });
                    return;
                }
                const result = await nodeManager.claimRewards();
                sendResponse({ success: true, data: result });
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

// Check if action should be rate limited
function shouldRateLimit(action) {
    const rateLimitedActions = [
        'api_call',
        'dapp_connect',
        'bulk_sign'
    ];
    return rateLimitedActions.includes(action);
}

// Handle DApp requests
async function handleDappRequest(request, sender) {
    try {
        // Check phishing
        const urlCheck = await phishingDetector.checkUrl(sender.tab.url);
        if (phishingDetector.shouldBlock(urlCheck)) {
            return {
                error: {
                    code: -32000,
                    message: phishingDetector.getWarningMessage(urlCheck)
                }
            };
        }
        
        // Check if connected
        const origin = new URL(sender.tab.url).origin;
        const isConnected = await checkDappConnection(origin);
        
        switch (request.method) {
            case 'qnet_requestAccounts':
                if (!isConnected) {
                    const granted = await showPermissionPopup(origin, ['view_accounts']);
                    if (!granted) {
                        return { result: [] };
                    }
                    await storageManager.addConnectedSite(origin, ['view_accounts']);
                }
                
                if (!isUnlocked) {
                    return { result: [] };
                }
                
                return { result: [walletManager.getCurrentAddress()] };
                
            case 'qnet_sendTransaction':
                if (!isUnlocked) {
                    return { error: { code: -32000, message: 'Wallet locked' } };
                }
                
                if (!isConnected) {
                    return { error: { code: -32000, message: 'Not connected' } };
                }
                
                // Validate transaction
                const tx = request.params[0];
                if (!walletManager.crypto.validateAddress(tx.to)) {
                    return { error: { code: -32602, message: 'Invalid recipient address' } };
                }
                
                if (!walletManager.crypto.validateAmount(tx.value || tx.amount)) {
                    return { error: { code: -32602, message: 'Invalid amount' } };
                }
                
                // Get transaction history and balance for audit
                const dappAddress = walletManager.getCurrentAddress();
                const dappTxHistory = await networkManager.getTransactions(dappAddress);
                const dappBalance = await networkManager.getBalance(dappAddress);
                
                // Create transaction object
                const dappTx = {
                    from: dappAddress,
                    to: tx.to,
                    amount: tx.value || tx.amount,
                    memo: tx.data || '',
                    timestamp: Date.now(),
                    nonce: await networkManager.getNonce(dappAddress)
                };
                
                // Add replay protection
                const protectedDappTx = replayProtection.addChainProtection(dappTx);
                
                // Audit transaction
                const dappAuditResult = await transactionAuditor.auditTransaction(
                    protectedDappTx,
                    dappTxHistory,
                    dappBalance
                );
                
                // Always show confirmation for DApp transactions with audit info
                const approved = await showTransactionPopup(tx, origin, dappAuditResult);
                if (!approved) {
                    return { error: { code: 4001, message: 'User rejected transaction' } };
                }
                
                const txHash = await walletManager.sendTransaction(
                    tx.to,
                    tx.value || tx.amount,
                    tx.data || ''
                );
                
                return { result: txHash };
                
            default:
                return { error: { code: -32601, message: 'Method not found' } };
        }
    } catch (error) {
        return { error: { code: -32603, message: error.message } };
    }
}

// Check if DApp is connected
async function checkDappConnection(origin) {
    const connectedSites = await storageManager.getConnectedSites();
    return connectedSites.some(site => site.origin === origin);
}

// Get comprehensive wallet data
async function getWalletData() {
    const address = walletManager.getCurrentAddress();
    const balance = await networkManager.getBalance(address);
    const transactions = await networkManager.getTransactions(address);
    const nodeStatus = await nodeManager.getNodeStatus();
    
    return {
        address,
        balance,
        transactions,
        nodeStatus
    };
}

// Show permission popup
async function showPermissionPopup(origin, permissions) {
    return new Promise((resolve) => {
        chrome.windows.create({
            url: chrome.runtime.getURL(`permission.html?origin=${origin}&permissions=${permissions.join(',')}`),
            type: 'popup',
            width: 400,
            height: 600
        }, (window) => {
            // Listen for permission response
            chrome.runtime.onMessage.addListener(function listener(request) {
                if (request.action === 'permissionResponse' && request.windowId === window.id) {
                    chrome.runtime.onMessage.removeListener(listener);
                    resolve(request.granted);
                }
            });
        });
    });
}

// Show risk warning popup
async function showRiskWarning(auditResult) {
    return new Promise((resolve) => {
        chrome.windows.create({
            url: chrome.runtime.getURL(`risk-warning.html?${new URLSearchParams({
                riskLevel: auditResult.riskLevel,
                score: auditResult.score,
                flags: JSON.stringify(auditResult.flags)
            })}`),
            type: 'popup',
            width: 400,
            height: 500
        }, (window) => {
            chrome.runtime.onMessage.addListener(function listener(request) {
                if (request.action === 'riskResponse' && request.windowId === window.id) {
                    chrome.runtime.onMessage.removeListener(listener);
                    resolve(request.confirmed);
                }
            });
        });
    });
}

// Show transaction confirmation popup with audit info
async function showTransactionPopup(tx, origin, auditResult = null) {
    return new Promise((resolve) => {
        const params = {
            to: tx.to,
            amount: tx.value || tx.amount,
            origin: origin
        };
        
        if (auditResult) {
            params.riskLevel = auditResult.riskLevel;
            params.auditFlags = JSON.stringify(auditResult.flags);
        }
        
        chrome.windows.create({
            url: chrome.runtime.getURL(`confirm-tx.html?${new URLSearchParams(params)}`),
            type: 'popup',
            width: 400,
            height: 600
        }, (window) => {
            chrome.runtime.onMessage.addListener(function listener(request) {
                if (request.action === 'txResponse' && request.windowId === window.id) {
                    chrome.runtime.onMessage.removeListener(listener);
                    resolve(request.approved);
                }
            });
        });
    });
}

// Reset auto-lock timer
function resetAutoLock() {
    clearTimeout(unlockTimeout);
    unlockTimeout = setTimeout(() => {
        walletManager.lock();
        isUnlocked = false;
    }, AUTO_LOCK_TIME);
}

// Handle extension installation
chrome.runtime.onInstalled.addListener(async (details) => {
    if (details.reason === 'install') {
        // Open welcome page
        chrome.tabs.create({
            url: chrome.runtime.getURL('welcome.html')
        });
    }
});

// Handle alarm for periodic tasks
chrome.alarms.create('periodicTasks', { periodInMinutes: 1 });
chrome.alarms.create('cleanup', { periodInMinutes: 30 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'periodicTasks') {
        // Update balances
        if (isUnlocked) {
            await updateWalletData();
        }
    } else if (alarm.name === 'cleanup') {
        // Clean up rate limiter
        rateLimiter.cleanup();
    }
});

// Update wallet data
async function updateWalletData() {
    const address = walletManager.getCurrentAddress();
    const balance = await networkManager.getBalance(address);
    
    // Send update to popup if open
    chrome.runtime.sendMessage({
        action: 'walletDataUpdate',
        data: { balance }
    }).catch(() => {
        // Popup not open, ignore
    });
}

// Content script injection for DApp interaction
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url) {
        // Inject QNet provider
        chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: ['inject.js'],
            world: 'MAIN'
        });
    }
});

// Export for testing
export { walletManager, nodeManager, networkManager }; 