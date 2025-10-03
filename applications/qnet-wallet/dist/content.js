/**
 * QNet Wallet Content Script - Production Provider Injection
 * Injects wallet provider into page context for website interaction
 */

// Don't run in extension popup/options pages
if (window.location.protocol !== 'chrome-extension:') {
    // Log:('🔧 QNet Content Script Loading on:', window.location.href);

// Inject the provider script into page context
function injectQNetProvider() {
    try {
        // Log:('🚀 Attempting to inject QNet provider...');
        
        // Method 1: Try direct script injection
        const script = document.createElement('script');
        script.setAttribute('async', 'false');
        script.src = chrome.runtime.getURL('inject.js');
        
        // Inject into page head or documentElement
        const target = document.head || document.documentElement;
        if (target) {
            target.appendChild(script);
            // Log:('✅ QNet provider injection script loaded');
            
            // Remove script element after injection
            script.onload = () => {
                script.remove();
                // Log:('🧹 QNet injection script element removed');
                
                // Verify injection worked
                setTimeout(() => {
                    if (typeof window.qnet === 'undefined') {
                        // Log:('🔄 Direct injection failed, trying inline injection...');
                        injectInlineProvider();
                    }
                }, 100);
            };
            
            script.onerror = (error) => {
                // Error:('❌ QNet injection script error:', error);
                // Log:('🔄 Script injection failed, trying inline injection...');
                injectInlineProvider();
            };
        } else {
            // Error:('❌ No target element found for injection');
            injectInlineProvider();
        }
    } catch (error) {
        // Error:('❌ Failed to inject QNet provider:', error);
        injectInlineProvider();
    }
}

// Fallback: Inject provider code directly inline
function injectInlineProvider() {
    try {
        // Log:('🔄 Attempting inline QNet provider injection...');
        
        const script = document.createElement('script');
        script.textContent = `
(function() {
    'use strict';
    
    // Prevent multiple injections
    if (window.qnet) {
        return;
    }

    // Log:('🚀 QNet Wallet Provider Injecting (Inline)...');

    // QNet Wallet Provider Implementation
    class QNetWalletProvider {
        constructor() {
            this.isQNetWallet = true;
            this.connected = false;
            this.accounts = [];
            this.networkVersion = 'mainnet';
            this.requestId = 0;
        }

        // Connect to wallet
        async connect() {
            try {
                const response = await this.request({ method: 'connect' });
                if (response && response.accounts) {
                    this.accounts = response.accounts;
                    this.connected = true;
                    this.emit('accountsChanged', this.accounts);
                    return this.accounts;
                }
                return [];
            } catch (error) {
                // Error:('QNet connect error:', error);
                throw error;
            }
        }

        // Disconnect from wallet
        async disconnect() {
            try {
                await this.request({ method: 'disconnect' });
                this.accounts = [];
                this.connected = false;
                this.emit('accountsChanged', []);
                this.emit('disconnect');
            } catch (error) {
                // Error:('QNet disconnect error:', error);
            }
        }

        // Check if connected
        isConnected() {
            return this.connected && this.accounts.length > 0;
        }

        // Get accounts
        getAccounts() {
            return this.accounts;
        }

        // Request method - main communication with extension
        async request(args) {
            return new Promise((resolve, reject) => {
                const id = ++this.requestId;
                
                // Listen for response
                const responseHandler = (event) => {
                    if (event.source !== window) return;
                    
                    const data = event.data;
                    if (!data || data.target !== 'qnet-wallet-inject' || data.id !== id) return;
                    
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
        }

        // Event handling
        on(event, handler) {
            if (!this.listeners) this.listeners = {};
            if (!this.listeners[event]) this.listeners[event] = [];
            this.listeners[event].push(handler);
        }

        removeListener(event, handler) {
            if (!this.listeners || !this.listeners[event]) return;
            const index = this.listeners[event].indexOf(handler);
            if (index > -1) {
                this.listeners[event].splice(index, 1);
            }
        }

        emit(event, ...args) {
            if (!this.listeners || !this.listeners[event]) return;
            this.listeners[event].forEach(handler => {
                try {
                    handler(...args);
                } catch (error) {
                    // Error:('QNet event handler error:', error);
                }
            });
        }

        // Sign transaction
        async signTransaction(transaction) {
            return this.request({
                method: 'signTransaction',
                params: { transaction }
            });
        }

        // Sign and send transaction
        async signAndSendTransaction(transaction) {
            return this.request({
                method: 'signAndSendTransaction',
                params: { transaction }
            });
        }

        // Sign message
        async signMessage(message) {
            return this.request({
                method: 'signMessage',
                params: { message }
            });
        }
    }

    // Create and inject provider
    const qnetProvider = new QNetWalletProvider();
    
    // Inject into window
    Object.defineProperty(window, 'qnet', {
        value: qnetProvider,
        writable: false,
        configurable: false
    });

    // Also provide as qnetWallet for compatibility
    Object.defineProperty(window, 'qnetWallet', {
        value: qnetProvider,
        writable: false,
        configurable: false
    });

    // Log:('✅ QNet Wallet Provider Injected (Inline)');

    // Dispatch ready event
    window.dispatchEvent(new CustomEvent('qnet#initialized', {
        detail: qnetProvider
    }));

})();
        `;
        
        const target = document.head || document.documentElement;
        if (target) {
            // For extension pages, direct injection works
            if (window.location.protocol === 'chrome-extension:') {
                // Log:('Extension context - skipping inline injection');
                return;
            }
            
            target.appendChild(script);
            script.remove(); // Remove immediately after execution
            // Log:('✅ QNet provider injected inline successfully');
        }
        
    } catch (error) {
        // Error:('❌ Failed to inject inline provider:', error);
    }
}

// Message relay between page and extension
function setupMessageRelay() {
    // Log:('🔗 Setting up QNet message relay...');
    
    // Listen for messages from page
    window.addEventListener('message', async (event) => {
        if (event.source !== window) return;
        
        const data = event.data;
        if (!data || data.target !== 'qnet-wallet-content') return;
        
        // Log:('📨 Content script received message:', data);
        
        try {
            // Forward request to background script
            const response = await chrome.runtime.sendMessage({
                type: 'WALLET_REQUEST',
                method: data.method,
                params: data.params,
                id: data.id
            });
            
            // Log:('📤 Background response:', response);
            
            // Send response back to page
            window.postMessage({
                target: 'qnet-wallet-inject',
                id: data.id,
                result: response.result,
                error: response.error
            }, '*');
            
        } catch (error) {
            // Error:('Content script message relay error:', error);
            
            // Send error response back to page
            window.postMessage({
                target: 'qnet-wallet-inject',
                id: data.id,
                error: { message: error.message || 'Communication error' }
            }, '*');
        }
    });
    
    // Log:('✅ QNet message relay established');
}

// Main initialization
function initializeQNetWallet() {
    // Log:('🎯 Initializing QNet Wallet on:', window.location.href);
    
    // Only inject once
    if (window.qnetWalletInjected) {
        // Log:('⚠️ QNet Wallet already injected, skipping');
        return;
    }
    
    window.qnetWalletInjected = true;
    
    // Setup message relay first
    setupMessageRelay();
    
    // Inject provider script
    if (document.readyState === 'loading') {
        // Log:('📄 Document loading, waiting for DOMContentLoaded...');
        document.addEventListener('DOMContentLoaded', injectQNetProvider);
    } else {
        // Log:('📄 Document ready, injecting immediately...');
        injectQNetProvider();
    }
    
    // Also check periodically if window.qnet exists
    let checkCount = 0;
    const checkInterval = setInterval(() => {
        checkCount++;
        const hasQnet = typeof window.qnet !== 'undefined';
        // Log:(`🔍 Check ${checkCount}: window.qnet exists:`, hasQnet);
        
        if (hasQnet || checkCount >= 10) {
            clearInterval(checkInterval);
            if (hasQnet) {
                // Log:('✅ QNet provider successfully injected and accessible');
            } else {
                // Error:('❌ QNet provider not accessible after 10 checks');
            }
        }
    }, 1000);
}

// Initialize immediately for early injection
// Log:('🚀 QNet Content Script: Starting initialization...');
initializeQNetWallet();

// Also handle late navigation
if (document.readyState !== 'complete') {
    window.addEventListener('load', () => {
        // Log:('🔄 Window loaded, re-initializing QNet Wallet...');
        initializeQNetWallet();
    });
}

} // Close the if (window.location.protocol !== 'chrome-extension:') block
