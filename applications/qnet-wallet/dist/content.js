// QNet Wallet Content Script - PRODUCTION VERSION
// NO SCRIPT INJECTION - NO CSP ERRORS!

'use strict';

(function() {
    // Skip if in extension context
    if (window.location.protocol === 'chrome-extension:') return;
    
    // Skip special browser pages (but allow file:// for testing)
    if (['chrome:', 'edge:', 'about:'].includes(window.location.protocol)) return;
    
    // Mark as initialized
    if (window.qnetWalletInitialized) return;
    window.qnetWalletInitialized = true;
    
    // Create provider API directly - NO appendChild!
    const provider = {
        isQNetWallet: true,
        isQNet: true,
        version: '2.0.0',
        _requestId: 0,
        
        async request(args) {
            return new Promise((resolve, reject) => {
                const id = ++this._requestId;
                
                const handler = (event) => {
                    // SECURITY: Check origin
                    if (event.source !== window) return;
                    if (!event.data || event.data.target !== 'qnet-page' || event.data.id !== id) return;
                    
                    window.removeEventListener('message', handler);
                    
                    if (event.data.error) {
                        reject(new Error(event.data.error.message || 'Request failed'));
                    } else {
                        resolve(event.data.result);
                    }
                };
                
                window.addEventListener('message', handler);
                
                // Send to content script
                window.postMessage({
                    target: 'qnet-content',
                    method: args.method,
                    params: args.params || {},
                    id: id,
                    origin: window.location.origin // SECURITY: Include origin
                }, window.location.origin); // SECURITY: Specify target origin
                
                // Timeout
                setTimeout(() => {
                    window.removeEventListener('message', handler);
                    reject(new Error('Request timeout'));
                }, 30000);
            });
        },
        
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
    
    // Make provider available
    Object.defineProperty(window, 'qnet', {
        value: provider,
        writable: false,
        configurable: false
    });
    
    Object.defineProperty(window, 'qnetWallet', {
        value: provider,
        writable: false,
        configurable: false
    });
    
    // Message relay
    window.addEventListener('message', async (event) => {
        // SECURITY: Strict origin check
        if (event.source !== window) return;
        if (event.origin !== window.location.origin) return; // SECURITY FIX
        
        const message = event.data;
        if (!message || message.target !== 'qnet-content') return;
        
        // Verify origin matches
        if (message.origin && message.origin !== window.location.origin) {
            console.warn('Origin mismatch blocked');
            return;
        }
        
        try {
            // Forward to background
            const response = await chrome.runtime.sendMessage({
                type: 'qnet-request',
                method: message.method,
                params: message.params,
                id: message.id,
                origin: window.location.origin // Include origin for verification
            });
            
            // Send response
            window.postMessage({
                target: 'qnet-page',
                id: message.id,
                result: response.result,
                error: response.error
            }, window.location.origin); // SECURITY: Specify target
            
        } catch (error) {
            window.postMessage({
                target: 'qnet-page',
                id: message.id,
                error: {
                    message: error.message || 'Extension communication failed',
                    code: -32603
                }
            }, window.location.origin);
        }
    });
    
    // Listen for background events
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message || !message.type) return;
        
        if (message.type === 'qnet-event') {
            window.postMessage({
                target: 'qnet-page',
                event: message.event,
                data: message.data
            }, window.location.origin);
        }
    });
    
    // Dispatch ready event
    window.dispatchEvent(new CustomEvent('qnet#initialized', {
        detail: provider
    }));
    
    console.log('✅ QNet Wallet Ready (Production Mode)');
})();