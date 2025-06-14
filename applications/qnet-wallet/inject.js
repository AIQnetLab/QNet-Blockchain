// QNet Provider Injection Script

(function() {
    'use strict';
    
    // QNet Provider Class
    class QNetProvider {
        constructor() {
            this.isQNet = true;
            this.version = '1.0.0';
            this.connected = false;
            this.selectedAddress = null;
            this.networkVersion = 'qnet-mainnet';
            
            this._requestId = 0;
            this._pendingRequests = new Map();
            this._eventListeners = new Map();
            
            // Listen for messages from content script
            window.addEventListener('message', this._handleMessage.bind(this));
        }
        
        // Request method
        async request({ method, params }) {
            const id = ++this._requestId;
            
            return new Promise((resolve, reject) => {
                this._pendingRequests.set(id, { resolve, reject });
                
                // Send request to content script
                window.postMessage({
                    target: 'qnet-wallet-content',
                    method,
                    params,
                    id
                }, '*');
                
                // Timeout after 30 seconds
                setTimeout(() => {
                    if (this._pendingRequests.has(id)) {
                        this._pendingRequests.delete(id);
                        reject(new Error('Request timeout'));
                    }
                }, 30000);
            });
        }
        
        // Legacy send method for compatibility
        send(payload, callback) {
            if (callback) {
                this.request(payload)
                    .then(result => callback(null, { result }))
                    .catch(error => callback(error));
            } else {
                return this.request(payload);
            }
        }
        
        // Legacy sendAsync method for compatibility
        sendAsync(payload, callback) {
            this.send(payload, callback);
        }
        
        // Connect wallet
        async connect() {
            try {
                const accounts = await this.request({
                    method: 'qnet_requestAccounts',
                    params: []
                });
                
                if (accounts && accounts.length > 0) {
                    this.selectedAddress = accounts[0];
                    this.connected = true;
                    this._emit('connect', { chainId: this.networkVersion });
                    this._emit('accountsChanged', accounts);
                }
                
                return accounts;
            } catch (error) {
                this.connected = false;
                throw error;
            }
        }
        
        // Disconnect wallet
        disconnect() {
            this.connected = false;
            this.selectedAddress = null;
            this._emit('disconnect');
            this._emit('accountsChanged', []);
        }
        
        // Check if connected
        isConnected() {
            return this.connected;
        }
        
        // Event handling
        on(event, handler) {
            if (!this._eventListeners.has(event)) {
                this._eventListeners.set(event, new Set());
            }
            this._eventListeners.get(event).add(handler);
        }
        
        off(event, handler) {
            if (this._eventListeners.has(event)) {
                this._eventListeners.get(event).delete(handler);
            }
        }
        
        once(event, handler) {
            const wrappedHandler = (...args) => {
                handler(...args);
                this.off(event, wrappedHandler);
            };
            this.on(event, wrappedHandler);
        }
        
        removeListener(event, handler) {
            this.off(event, handler);
        }
        
        removeAllListeners(event) {
            if (event) {
                this._eventListeners.delete(event);
            } else {
                this._eventListeners.clear();
            }
        }
        
        // Emit event
        _emit(event, ...args) {
            if (this._eventListeners.has(event)) {
                this._eventListeners.get(event).forEach(handler => {
                    try {
                        handler(...args);
                    } catch (error) {
                        console.error('Error in event handler:', error);
                    }
                });
            }
        }
        
        // Handle messages from content script
        _handleMessage(event) {
            if (event.source !== window) return;
            
            const data = event.data;
            if (!data || data.target !== 'qnet-wallet-inject') return;
            
            // Handle responses
            if (data.id && this._pendingRequests.has(data.id)) {
                const { resolve, reject } = this._pendingRequests.get(data.id);
                this._pendingRequests.delete(data.id);
                
                if (data.error) {
                    reject(new Error(data.error.message || 'Unknown error'));
                } else {
                    resolve(data.result);
                }
            }
            
            // Handle events
            if (data.type === 'connectionChanged') {
                this.connected = data.connected;
                if (data.connected) {
                    this._emit('connect', { chainId: this.networkVersion });
                } else {
                    this.selectedAddress = null;
                    this._emit('disconnect');
                    this._emit('accountsChanged', []);
                }
            }
        }
        
        // Standard methods
        async qnet_requestAccounts() {
            return this.request({ method: 'qnet_requestAccounts' });
        }
        
        async qnet_accounts() {
            return this.request({ method: 'qnet_accounts' });
        }
        
        async qnet_chainId() {
            return this.networkVersion;
        }
        
        async qnet_sendTransaction(params) {
            return this.request({ method: 'qnet_sendTransaction', params });
        }
        
        async qnet_sign(params) {
            return this.request({ method: 'qnet_sign', params });
        }
        
        async qnet_signTypedData(params) {
            return this.request({ method: 'qnet_signTypedData', params });
        }
        
        async qnet_getBalance(address) {
            return this.request({ method: 'qnet_getBalance', params: [address] });
        }
        
        async qnet_getTransactionCount(address) {
            return this.request({ method: 'qnet_getTransactionCount', params: [address] });
        }
        
        async qnet_getTransactionReceipt(txHash) {
            return this.request({ method: 'qnet_getTransactionReceipt', params: [txHash] });
        }
        
        // Node-specific methods
        async qnet_getNodeStatus() {
            return this.request({ method: 'qnet_getNodeStatus' });
        }
        
        async qnet_activateNode(nodeType) {
            return this.request({ method: 'qnet_activateNode', params: [nodeType] });
        }
        
        async qnet_claimNodeRewards() {
            return this.request({ method: 'qnet_claimNodeRewards' });
        }
    }
    
    // Create and inject provider
    const provider = new QNetProvider();
    
    // Inject into window
    window.qnet = provider;
    
    // Also inject as ethereum for compatibility with existing tools
    if (!window.ethereum) {
        window.ethereum = provider;
    }
    
    // Announce provider
    window.dispatchEvent(new Event('qnet#initialized'));
    
    // For compatibility with libraries expecting ethereum provider
    window.dispatchEvent(new Event('ethereum#initialized'));
})(); 