// QNet Wallet Provider - Injected into page context
// This script provides the window.qnet API for DApps

(function() {
    'use strict';
    
    // Prevent multiple injections
    if (window.qnet && window.qnet.isQNetWallet) {
        console.log('QNet Wallet already injected');
        return;
    }

    // QNet Wallet Provider Implementation
    class QNetWalletProvider {
        constructor() {
            this.isQNetWallet = true;
            this.isQNet = true;
            this.connected = false;
            this.accounts = [];
            this.networkVersion = 'mainnet';
            this.requestId = 0;
            this.version = '2.0.0';
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

        // Get current selected address (Solana address)
        get selectedAddress() {
            return this.accounts && this.accounts.length > 0 ? this.accounts[0] : null;
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
                }, window.location.origin);
                
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
        
        // Get public key
        async getPublicKey() {
            return this.request({
                method: 'getPublicKey'
            });
        }
        
        // Switch network
        async switchNetwork(network) {
            return this.request({
                method: 'switchNetwork',
                params: { network }
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

    console.log('✅ QNet Wallet Provider Injected (v2.0.0)');

    // Dispatch ready event
    window.dispatchEvent(new CustomEvent('qnet#initialized', {
        detail: qnetProvider
    }));

})();