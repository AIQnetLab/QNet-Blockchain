/**
 * QNet Mobile DApp Browser
 * Provides web3 functionality for mobile apps like Phantom wallet
 */

export class DAppBrowser {
    constructor(walletManager) {
        this.walletManager = walletManager;
        this.webView = null;
        this.connectedSites = new Set();
        this.pendingRequests = new Map();
    }
    
    /**
     * Initialize DApp browser
     */
    async initialize() {
        await this.setupWebView();
        await this.injectWeb3Provider();
        this.setupMessageHandlers();
    }
    
    /**
     * Setup WebView for DApp browsing
     */
    async setupWebView() {
        // Create WebView container
        const container = document.createElement('div');
        container.id = 'dapp-browser-container';
        container.className = 'dapp-browser hidden';
        container.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: white;
            z-index: 1000;
        `;
        
        // Browser UI
        container.innerHTML = `
            <div class="browser-header">
                <button id="browser-back">←</button>
                <input id="browser-url" placeholder="Enter URL or search..." />
                <button id="browser-menu">⋯</button>
            </div>
            <div class="browser-content">
                <iframe id="dapp-webview" src="about:blank" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>
            </div>
            <div class="browser-footer">
                <button id="browser-home">🏠</button>
                <button id="browser-tabs">📑</button>
                <button id="browser-bookmarks">⭐</button>
                <button id="browser-settings">⚙️</button>
            </div>
        `;
        
        document.body.appendChild(container);
        
        this.webView = document.getElementById('dapp-webview');
        this.setupBrowserControls();
    }
    
    /**
     * Setup browser controls
     */
    setupBrowserControls() {
        const urlInput = document.getElementById('browser-url');
        const backButton = document.getElementById('browser-back');
        
        urlInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.navigateToUrl(urlInput.value);
            }
        });
        
        backButton.addEventListener('click', () => {
            this.goBack();
        });
        
        // Add other control handlers
        document.getElementById('browser-home').addEventListener('click', () => {
            this.navigateHome();
        });
    }
    
    /**
     * Navigate to URL
     */
    navigateToUrl(url) {
        try {
            // Validate and format URL
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                url = 'https://' + url;
            }
            
            const urlObj = new URL(url);
            
            // Security check for known DApp domains
            if (this.isAllowedDomain(urlObj.hostname)) {
                this.webView.src = url;
                document.getElementById('browser-url').value = url;
            } else {
                this.showSecurityWarning(urlObj.hostname);
            }
            
        } catch (error) {
            this.showError('Invalid URL');
        }
    }
    
    /**
     * Check if domain is allowed
     */
    isAllowedDomain(hostname) {
        const allowedDomains = [
            'app.uniswap.org',
            'pancakeswap.finance',
            'aave.com',
            'compound.finance',
            'opensea.io',
            'raydium.io',
            'jupiter.ag',
            'solend.fi',
            'marinade.finance',
            'orca.so',
            'localhost',
            '127.0.0.1'
        ];
        
        return allowedDomains.some(domain => 
            hostname === domain || hostname.endsWith('.' + domain)
        );
    }
    
    /**
     * Inject Web3 provider into webpage
     */
    async injectWeb3Provider() {
        const providerScript = `
            (function() {
                class QNetProvider {
                    constructor() {
                        this.isQNet = true;
                        this.isPhantom = true; // Phantom compatibility
                        this.isConnected = false;
                        this.publicKey = null;
                    }
                    
                    async connect() {
                        return new Promise((resolve, reject) => {
                            const requestId = Date.now().toString();
                            window.parent.postMessage({
                                type: 'QNET_CONNECT_REQUEST',
                                requestId: requestId,
                                origin: window.location.origin
                            }, '*');
                            
                            const handler = (event) => {
                                if (event.data.requestId === requestId) {
                                    window.removeEventListener('message', handler);
                                    if (event.data.success) {
                                        this.isConnected = true;
                                        this.publicKey = event.data.publicKey;
                                        resolve({ publicKey: event.data.publicKey });
                                    } else {
                                        reject(new Error(event.data.error));
                                    }
                                }
                            };
                            window.addEventListener('message', handler);
                        });
                    }
                    
                    async disconnect() {
                        this.isConnected = false;
                        this.publicKey = null;
                        window.parent.postMessage({
                            type: 'QNET_DISCONNECT',
                            origin: window.location.origin
                        }, '*');
                    }
                    
                    async signTransaction(transaction) {
                        return new Promise((resolve, reject) => {
                            const requestId = Date.now().toString();
                            window.parent.postMessage({
                                type: 'QNET_SIGN_TRANSACTION',
                                requestId: requestId,
                                transaction: transaction,
                                origin: window.location.origin
                            }, '*');
                            
                            const handler = (event) => {
                                if (event.data.requestId === requestId) {
                                    window.removeEventListener('message', handler);
                                    if (event.data.success) {
                                        resolve(event.data.signedTransaction);
                                    } else {
                                        reject(new Error(event.data.error));
                                    }
                                }
                            };
                            window.addEventListener('message', handler);
                        });
                    }
                    
                    async signMessage(message) {
                        return new Promise((resolve, reject) => {
                            const requestId = Date.now().toString();
                            window.parent.postMessage({
                                type: 'QNET_SIGN_MESSAGE',
                                requestId: requestId,
                                message: message,
                                origin: window.location.origin
                            }, '*');
                            
                            const handler = (event) => {
                                if (event.data.requestId === requestId) {
                                    window.removeEventListener('message', handler);
                                    if (event.data.success) {
                                        resolve(event.data.signature);
                                    } else {
                                        reject(new Error(event.data.error));
                                    }
                                }
                            };
                            window.addEventListener('message', handler);
                        });
                    }
                }
                
                // Make provider available globally
                window.qnet = new QNetProvider();
                window.solana = window.qnet; // Phantom compatibility
                
                // Dispatch ready event
                window.dispatchEvent(new Event('qnet#initialized'));
                
            })();
        `;
        
        // Inject script when page loads
        this.webView.addEventListener('load', () => {
            try {
                const doc = this.webView.contentDocument;
                if (doc) {
                    const script = doc.createElement('script');
                    script.textContent = providerScript;
                    doc.head.appendChild(script);
                }
            } catch (error) {
                console.error('Failed to inject provider:', error);
            }
        });
    }
    
    /**
     * Setup message handlers for DApp communication
     */
    setupMessageHandlers() {
        window.addEventListener('message', async (event) => {
            const { type, requestId, origin } = event.data;
            
            try {
                switch (type) {
                    case 'QNET_CONNECT_REQUEST':
                        await this.handleConnectRequest(requestId, origin);
                        break;
                        
                    case 'QNET_SIGN_TRANSACTION':
                        await this.handleSignTransaction(requestId, event.data.transaction, origin);
                        break;
                        
                    case 'QNET_SIGN_MESSAGE':
                        await this.handleSignMessage(requestId, event.data.message, origin);
                        break;
                        
                    case 'QNET_DISCONNECT':
                        await this.handleDisconnect(origin);
                        break;
                }
            } catch (error) {
                this.sendResponse(requestId, { success: false, error: error.message });
            }
        });
    }
    
    /**
     * Handle connection request
     */
    async handleConnectRequest(requestId, origin) {
        try {
            // Show connection approval dialog
            const approved = await this.showConnectionDialog(origin);
            
            if (approved) {
                const currentAccount = this.walletManager.getCurrentAccount();
                if (currentAccount) {
                    this.connectedSites.add(origin);
                    await this.walletManager.storeConnection(origin);
                    
                    this.sendResponse(requestId, {
                        success: true,
                        publicKey: currentAccount.address
                    });
                } else {
                    throw new Error('No active account');
                }
            } else {
                throw new Error('User rejected connection');
            }
        } catch (error) {
            this.sendResponse(requestId, { success: false, error: error.message });
        }
    }
    
    /**
     * Handle transaction signing
     */
    async handleSignTransaction(requestId, transaction, origin) {
        try {
            if (!this.connectedSites.has(origin)) {
                throw new Error('Site not connected');
            }
            
            // Show transaction approval dialog
            const approved = await this.showTransactionDialog(transaction, origin);
            
            if (approved) {
                const signedTx = await this.walletManager.signTransaction(transaction);
                this.sendResponse(requestId, { success: true, signedTransaction: signedTx });
            } else {
                throw new Error('User rejected transaction');
            }
        } catch (error) {
            this.sendResponse(requestId, { success: false, error: error.message });
        }
    }
    
    /**
     * Handle message signing
     */
    async handleSignMessage(requestId, message, origin) {
        try {
            if (!this.connectedSites.has(origin)) {
                throw new Error('Site not connected');
            }
            
            const approved = await this.showMessageDialog(message, origin);
            
            if (approved) {
                const signature = await this.walletManager.signMessage(message);
                this.sendResponse(requestId, { success: true, signature: signature });
            } else {
                throw new Error('User rejected message signing');
            }
        } catch (error) {
            this.sendResponse(requestId, { success: false, error: error.message });
        }
    }
    
    /**
     * Send response to DApp
     */
    sendResponse(requestId, response) {
        this.webView.contentWindow.postMessage({
            requestId: requestId,
            ...response
        }, '*');
    }
    
    /**
     * Show connection approval dialog
     */
    async showConnectionDialog(origin) {
        return new Promise((resolve) => {
            const modal = this.createModal(`
                <h3>🔗 Connection Request</h3>
                <p><strong>${origin}</strong> wants to connect to your wallet</p>
                <p>This will allow the site to:</p>
                <ul>
                    <li>View your wallet address</li>
                    <li>Request transaction approvals</li>
                    <li>Request message signatures</li>
                </ul>
                <div class="modal-actions">
                    <button id="reject-connection">Reject</button>
                    <button id="approve-connection" class="primary">Connect</button>
                </div>
            `);
            
            modal.querySelector('#reject-connection').onclick = () => {
                modal.remove();
                resolve(false);
            };
            
            modal.querySelector('#approve-connection').onclick = () => {
                modal.remove();
                resolve(true);
            };
        });
    }
    
    /**
     * Show transaction approval dialog
     */
    async showTransactionDialog(transaction, origin) {
        return new Promise((resolve) => {
            const modal = this.createModal(`
                <h3>📝 Transaction Request</h3>
                <p><strong>${origin}</strong> wants to send a transaction</p>
                <div class="transaction-details">
                    <pre>${JSON.stringify(transaction, null, 2)}</pre>
                </div>
                <div class="modal-actions">
                    <button id="reject-transaction">Reject</button>
                    <button id="approve-transaction" class="primary">Sign & Send</button>
                </div>
            `);
            
            modal.querySelector('#reject-transaction').onclick = () => {
                modal.remove();
                resolve(false);
            };
            
            modal.querySelector('#approve-transaction').onclick = () => {
                modal.remove();
                resolve(true);
            };
        });
    }
    
    /**
     * Create modal dialog
     */
    createModal(content) {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.style.cssText = `
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.7);
            backdrop-filter: blur(5px);
            z-index: 10001;
            display: flex;
            justify-content: center;
            align-items: center;
        `;
        
        const modal = document.createElement('div');
        modal.className = 'modal-box';
        modal.style.cssText = `
            background: white;
            border-radius: 12px;
            padding: 24px;
            max-width: 400px;
            width: 90%;
            max-height: 80vh;
            overflow-y: auto;
        `;
        
        modal.innerHTML = content;
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        
        return overlay;
    }
    
    /**
     * Show DApp browser
     */
    show() {
        const container = document.getElementById('dapp-browser-container');
        if (container) {
            container.classList.remove('hidden');
        }
    }
    
    /**
     * Hide DApp browser
     */
    hide() {
        const container = document.getElementById('dapp-browser-container');
        if (container) {
            container.classList.add('hidden');
        }
    }
    
    /**
     * Navigate to home page
     */
    navigateHome() {
        const homeUrl = 'https://app.uniswap.org'; // Default DApp
        this.navigateToUrl(homeUrl);
    }
    
    /**
     * Go back
     */
    goBack() {
        if (this.webView && this.webView.contentWindow) {
            this.webView.contentWindow.history.back();
        }
    }
} 