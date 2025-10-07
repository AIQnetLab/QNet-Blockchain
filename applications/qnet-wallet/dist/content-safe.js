// QNet Wallet Content Script - SAFE VERSION (No Script Injection)
// This version uses ONLY message passing, no appendChild errors!

'use strict';

// Don't run in extension popup/options pages
if (window.location.protocol !== 'chrome-extension:') {
    
    // Create a proxy provider that works through messages only
    const createProxyProvider = () => {
        // This object will be available as window.qnet
        const provider = {
            isQNetWallet: true,
            isQNet: true,
            version: '2.0.0',
            
            // Request ID counter
            _requestId: 0,
            
            // Main request method
            async request(args) {
                return new Promise((resolve, reject) => {
                    const id = ++this._requestId;
                    
                    // Listen for response
                    const responseHandler = (event) => {
                        if (event.source !== window) return;
                        
                        const data = event.data;
                        if (!data || data.target !== 'qnet-wallet-page' || data.id !== id) return;
                        
                        window.removeEventListener('message', responseHandler);
                        
                        if (data.error) {
                            reject(new Error(data.error.message || 'Request failed'));
                        } else {
                            resolve(data.result);
                        }
                    };
                    
                    window.addEventListener('message', responseHandler);
                    
                    // Send request to content script
                    window.postMessage({
                        target: 'qnet-wallet-content',
                        method: args.method,
                        params: args.params || {},
                        id: id
                    }, '*');
                    
                    // Timeout after 30 seconds
                    setTimeout(() => {
                        window.removeEventListener('message', responseHandler);
                        reject(new Error('Request timeout'));
                    }, 30000);
                });
            },
            
            // Public methods
            async connect() {
                return this.request({ method: 'connect' });
            },
            
            async disconnect() {
                return this.request({ method: 'disconnect' });
            },
            
            async signTransaction(transaction) {
                return this.request({ method: 'signTransaction', params: { transaction } });
            },
            
            async signMessage(message) {
                return this.request({ method: 'signMessage', params: { message } });
            },
            
            async getPublicKey() {
                return this.request({ method: 'getPublicKey' });
            },
            
            async switchNetwork(network) {
                return this.request({ method: 'switchNetwork', params: { network } });
            }
        };
        
        // Make provider available globally
        // Use Object.defineProperty to make it non-enumerable
        try {
            Object.defineProperty(window, 'qnet', {
                value: provider,
                writable: false,
                configurable: false,
                enumerable: false
            });
            
            // Also as qnetWallet for compatibility
            Object.defineProperty(window, 'qnetWallet', {
                value: provider,
                writable: false,
                configurable: false,
                enumerable: false
            });
            
            // Dispatch ready event
            window.dispatchEvent(new CustomEvent('qnet#initialized', {
                detail: provider
            }));
            
            console.log('✅ QNet Wallet Provider Ready (Safe Mode)');
        } catch (e) {
            console.warn('Could not define window.qnet - likely CSP restriction');
        }
    };
    
    // Message relay between page and extension
    const setupMessageRelay = () => {
        // Listen for messages from page
        window.addEventListener('message', async (event) => {
            if (event.source !== window) return;
            
            const message = event.data;
            if (!message || message.target !== 'qnet-wallet-content') return;
            
            try {
                // Forward to background script
                const response = await chrome.runtime.sendMessage({
                    type: 'qnet-request',
                    method: message.method,
                    params: message.params,
                    id: message.id
                });
                
                // Send response back to page
                window.postMessage({
                    target: 'qnet-wallet-page',
                    id: message.id,
                    result: response.result,
                    error: response.error
                }, '*');
                
            } catch (error) {
                // Send error back to page
                window.postMessage({
                    target: 'qnet-wallet-page',
                    id: message.id,
                    error: {
                        message: error.message || 'Failed to communicate with wallet extension',
                        code: -32603
                    }
                }, '*');
            }
        });
        
        // Listen for events from background
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (!message || !message.type) return;
            
            // Forward events to page
            if (message.type === 'qnet-event') {
                window.postMessage({
                    target: 'qnet-wallet-page',
                    event: message.event,
                    data: message.data
                }, '*');
            }
        });
    };
    
    // Initialize
    const initialize = () => {
        // Only initialize once
        if (window.qnetWalletInitialized) return;
        window.qnetWalletInitialized = true;
        
        // Setup message relay
        setupMessageRelay();
        
        // Create proxy provider (no script injection!)
        createProxyProvider();
    };
    
    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }
    
    // Also initialize on load for late injection
    window.addEventListener('load', initialize);
}
