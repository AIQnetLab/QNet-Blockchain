
// QNet Wallet Background Script
console.log('QNet Wallet Background Script Loaded');

// Basic message handling
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('Background message received:', request);
    sendResponse({ success: true });
});

// Tab management
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url) {
        console.log('Tab updated:', tab.url);
    }
});
