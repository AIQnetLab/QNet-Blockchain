/**
 * QNet Wallet Content Script - Web3 Provider Injection
 * Provides wallet functionality to websites like Phantom
 */

class QNetProvider {
    constructor() {
        this.isQNet = true;
        this.isConnected = false;
        this.publicKey = null;
        this._events = {};
    }

    /**
     * Connect to wallet
     */
    async connect() {
        try {
            const response = await this.sendMessage({ type: 'CONNECT' });
            if (response.success) {
                this.isConnected = true;
                this.publicKey = response.publicKey;
                this.emit('connect', { publicKey: this.publicKey });
                return { publicKey: this.publicKey };
            }
            throw new Error(response.error || 'Failed to connect');
        } catch (error) {
            throw error;
        }
    }

    /**
     * Disconnect from wallet
     */
    async disconnect() {
        this.isConnected = false;
        this.publicKey = null;
        this.emit('disconnect');
    }

    /**
     * Sign transaction
     */
    async signTransaction(transaction) {
        if (!this.isConnected) {
            throw new Error('Wallet not connected');
        }

        try {
            const response = await this.sendMessage({
                type: 'SIGN_TRANSACTION',
                transaction: transaction.serialize({ requireAllSignatures: false }).toString('base64')
            });

            if (response.success) {
                return response.signedTransaction;
            }
            throw new Error(response.error || 'Failed to sign transaction');
        } catch (error) {
            throw error;
        }
    }

    /**
     * Sign all transactions
     */
    async signAllTransactions(transactions) {
        const signedTransactions = [];
        for (const transaction of transactions) {
            const signed = await this.signTransaction(transaction);
            signedTransactions.push(signed);
        }
        return signedTransactions;
    }

    /**
     * Sign message
     */
    async signMessage(message) {
        if (!this.isConnected) {
            throw new Error('Wallet not connected');
        }

        try {
            const response = await this.sendMessage({
                type: 'SIGN_MESSAGE',
                message: message
            });

            if (response.success) {
                return response.signature;
            }
            throw new Error(response.error || 'Failed to sign message');
        } catch (error) {
            throw error;
        }
    }

    /**
     * Send message to extension
     */
    async sendMessage(message) {
        return new Promise((resolve, reject) => {
            const messageId = Date.now() + Math.random();
            
            const responseHandler = (event) => {
                if (event.data.type === 'QNET_RESPONSE' && event.data.messageId === messageId) {
                    window.removeEventListener('message', responseHandler);
                    resolve(event.data.response);
                }
            };

            window.addEventListener('message', responseHandler);

            // Send message to injected script
            window.postMessage({
                type: 'QNET_REQUEST',
                messageId: messageId,
                data: message
            }, '*');

            // Timeout after 30 seconds
            setTimeout(() => {
                window.removeEventListener('message', responseHandler);
                reject(new Error('Request timeout'));
            }, 30000);
        });
    }

    /**
     * Event handling
     */
    on(event, callback) {
        if (!this._events[event]) {
            this._events[event] = [];
        }
        this._events[event].push(callback);
    }

    off(event, callback) {
        if (this._events[event]) {
            this._events[event] = this._events[event].filter(cb => cb !== callback);
        }
    }

    emit(event, data) {
        if (this._events[event]) {
            this._events[event].forEach(callback => callback(data));
        }
    }
}

// Inject QNet provider into window
if (typeof window !== 'undefined' && !window.qnet) {
    const qnetProvider = new QNetProvider();
    
    // Make it available as window.qnet and window.solana for compatibility
    Object.defineProperty(window, 'qnet', {
        value: qnetProvider,
        writable: false,
        configurable: false
    });

    // Also provide Solana wallet interface compatibility
    if (!window.solana) {
        Object.defineProperty(window, 'solana', {
            value: qnetProvider,
            writable: false,
            configurable: false
        });
    }

    // Dispatch ready event
    window.dispatchEvent(new CustomEvent('qnet#initialized', {
        detail: qnetProvider
    }));

    console.log('QNet Wallet provider injected');
}
