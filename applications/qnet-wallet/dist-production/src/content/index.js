/**
 * QNet Wallet Content Script - Production Provider Injection
 * Injects wallet provider into page context for website interaction
 */

// Don't run in extension popup/options pages
if (window.location.protocol === 'chrome-extension:') {
    console.log('🚫 Content script skipped - running in extension context');
    // Exit early to prevent provider injection in extension pages
    return;
}

console.log('🔧 QNet Content Script Loading on:', window.location.href);

// Inject the provider script into page context
function injectQNetProvider() {
    try {
        console.log('🚀 Attempting to inject QNet provider...');
        
        // Method 1: Try direct script injection
        const script = document.createElement('script');
        script.setAttribute('async', 'false');
        script.src = chrome.runtime.getURL('inject.js');
        
        // Inject into page head or documentElement
        const target = document.head || document.documentElement;
        if (target) {
            target.appendChild(script);
            console.log('✅ QNet provider injection script loaded');
            
            // Remove script element after injection
            script.onload = () => {
                script.remove();
                console.log('🧹 QNet injection script element removed');
                
                // Verify injection worked
                setTimeout(() => {
                    if (typeof window.qnet === 'undefined') {
                        console.log('🔄 Direct injection failed, trying inline injection...');
                        injectInlineProvider();
                    }
                }, 100);
            };
            
            script.onerror = (error) => {
                console.error('❌ QNet injection script error:', error);
                console.log('🔄 Script injection failed, trying inline injection...');
                injectInlineProvider();
            };
        } else {
            console.error('❌ No target element found for injection');
            injectInlineProvider();
        }
    } catch (error) {
        console.error('❌ Failed to inject QNet provider:', error);
        injectInlineProvider();
    }
}

// Fallback: Inject provider code directly inline
function injectInlineProvider() {
    try {
        console.log('🔄 Attempting inline QNet provider injection...');
        
        const script = document.createElement('script');
        script.textContent = `
(function() {
    'use strict';
    
    // Prevent multiple injections
    if (window.qnet) {
        return;
    }

    console.log('🚀 QNet Wallet Provider Injecting (Inline)...');

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
                console.error('QNet connect error:', error);
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
                console.error('QNet disconnect error:', error);
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
                    console.error('QNet event handler error:', error);
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

    console.log('✅ QNet Wallet Provider Injected (Inline)');

    // Dispatch ready event
    window.dispatchEvent(new CustomEvent('qnet#initialized', {
        detail: qnetProvider
    }));

})();
        `;
        
        const target = document.head || document.documentElement;
        if (target) {
            target.appendChild(script);
            script.remove(); // Remove immediately after execution
            console.log('✅ QNet provider injected inline successfully');
        }
        
    } catch (error) {
        console.error('❌ Failed to inject inline provider:', error);
    }
}

// Message relay between page and extension
function setupMessageRelay() {
    console.log('🔗 Setting up QNet message relay...');
    
    // Listen for messages from page
    window.addEventListener('message', async (event) => {
        if (event.source !== window) return;
        
        const data = event.data;
        if (!data || data.target !== 'qnet-wallet-content') return;
        
        console.log('📨 Content script received message:', data);
        
        try {
            // Forward request to background script
            const response = await chrome.runtime.sendMessage({
                type: 'WALLET_REQUEST',
                method: data.method,
                params: data.params,
                id: data.id
            });
            
            console.log('📤 Background response:', response);
            
            // Send response back to page
            window.postMessage({
                target: 'qnet-wallet-inject',
                id: data.id,
                result: response.result,
                error: response.error
            }, '*');
            
        } catch (error) {
            console.error('Content script message relay error:', error);
            
            // Send error response back to page
            window.postMessage({
                target: 'qnet-wallet-inject',
                id: data.id,
                error: { message: error.message || 'Communication error' }
            }, '*');
        }
    });
    
    console.log('✅ QNet message relay established');
}

// Main initialization
function initializeQNetWallet() {
    console.log('🎯 Initializing QNet Wallet on:', window.location.href);
    
    // Only inject once
    if (window.qnetWalletInjected) {
        console.log('⚠️ QNet Wallet already injected, skipping');
        return;
    }
    
    window.qnetWalletInjected = true;
    
    // Setup message relay first
    setupMessageRelay();
    
    // Inject provider script
    if (document.readyState === 'loading') {
        console.log('📄 Document loading, waiting for DOMContentLoaded...');
        document.addEventListener('DOMContentLoaded', injectQNetProvider);
    } else {
        console.log('📄 Document ready, injecting immediately...');
        injectQNetProvider();
    }
    
    // Also check periodically if window.qnet exists
    let checkCount = 0;
    const checkInterval = setInterval(() => {
        checkCount++;
        const hasQnet = typeof window.qnet !== 'undefined';
        console.log(`🔍 Check ${checkCount}: window.qnet exists:`, hasQnet);
        
        if (hasQnet || checkCount >= 10) {
            clearInterval(checkInterval);
            if (hasQnet) {
                console.log('✅ QNet provider successfully injected and accessible');
            } else {
                console.error('❌ QNet provider not accessible after 10 checks');
            }
        }
    }, 1000);
}

// Initialize immediately for early injection
console.log('🚀 QNet Content Script: Starting initialization...');
initializeQNetWallet();

// Also handle late navigation
if (document.readyState !== 'complete') {
    window.addEventListener('load', () => {
        console.log('🔄 Window loaded, re-initializing QNet Wallet...');
        initializeQNetWallet();
    });
}
