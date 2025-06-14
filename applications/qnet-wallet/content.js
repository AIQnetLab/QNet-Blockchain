// QNet Wallet Content Script

// Inject provider script into page
const script = document.createElement('script');
script.src = chrome.runtime.getURL('inject.js');
script.onload = function() {
    this.remove();
};
(document.head || document.documentElement).appendChild(script);

// Listen for messages from injected script
window.addEventListener('message', async (event) => {
    // Only accept messages from same origin
    if (event.source !== window) return;
    
    // Check for QNet provider messages
    if (event.data && event.data.target === 'qnet-wallet-content') {
        const { method, params, id } = event.data;
        
        try {
            // Forward request to background script
            const response = await chrome.runtime.sendMessage({
                action: 'dappRequest',
                method,
                params,
                origin: window.location.origin
            });
            
            // Send response back to page
            window.postMessage({
                target: 'qnet-wallet-inject',
                id,
                result: response.result,
                error: response.error
            }, '*');
        } catch (error) {
            // Send error back to page
            window.postMessage({
                target: 'qnet-wallet-inject',
                id,
                error: {
                    code: -32603,
                    message: error.message
                }
            }, '*');
        }
    }
});

// Listen for connect/disconnect events
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'connectionChanged') {
        // Notify page about connection change
        window.postMessage({
            target: 'qnet-wallet-inject',
            type: 'connectionChanged',
            connected: request.connected
        }, '*');
    }
});

// Check initial connection status
chrome.runtime.sendMessage({
    action: 'checkConnection',
    origin: window.location.origin
}, (response) => {
    if (response && response.connected) {
        window.postMessage({
            target: 'qnet-wallet-inject',
            type: 'connectionChanged',
            connected: true
        }, '*');
    }
}); 