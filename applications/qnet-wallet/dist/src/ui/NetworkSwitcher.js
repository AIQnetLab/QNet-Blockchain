/**
 * Network Switcher UI Component
 * Allows users to switch between Solana and QNet networks
 */

export class NetworkSwitcher {
    constructor(dualNetworkManager, i18n) {
        this.networkManager = dualNetworkManager;
        this.i18n = i18n;
        this.currentNetwork = 'solana';
        this.phase = 1;
        this.listeners = new Set();
        
        this.init();
    }

    /**
     * Initialize network switcher
     */
    init() {
        this.createSwitcherUI();
        this.bindEvents();
        this.updateNetworkStatus();
        
        // Listen for network changes
        this.networkManager.addListener((event, data) => {
            this.handleNetworkEvent(event, data);
        });
    }

    /**
     * Create switcher UI elements
     */
    createSwitcherUI() {
        const container = document.getElementById('network-switcher');
        if (!container) return;

        container.innerHTML = `
            <div class="network-switcher-container">
                <div class="network-buttons">
                    <button class="network-btn solana-btn active" data-network="solana">
                        <div class="network-icon">🔥</div>
                        <div class="network-info">
                            <div class="network-name">${this.i18n.t('networks.solana')}</div>
                            <div class="network-purpose">${this.i18n.t('networks.solana_purpose')}</div>
                        </div>
                        <div class="network-status" id="solana-status">
                            <div class="status-indicator"></div>
                        </div>
                    </button>
                    
                    <button class="network-btn qnet-btn" data-network="qnet">
                        <div class="network-icon">💎</div>
                        <div class="network-info">
                            <div class="network-name">${this.i18n.t('networks.qnet')}</div>
                            <div class="network-purpose">${this.i18n.t('networks.qnet_purpose')}</div>
                        </div>
                        <div class="network-status" id="qnet-status">
                            <div class="status-indicator"></div>
                        </div>
                    </button>
                </div>
                
                <div class="phase-indicator">
                    <div class="phase-info">
                        <span class="phase-label">${this.i18n.t('phase.current')}</span>
                        <span class="phase-number" id="current-phase">1</span>
                        <span class="phase-description" id="phase-description">
                            ${this.i18n.t('phase.phase1_description')}
                        </span>
                    </div>
                </div>
                
                <div class="network-details" id="network-details">
                    <div class="detail-item">
                        <span class="detail-label">${this.i18n.t('network.rpc_url')}</span>
                        <span class="detail-value" id="rpc-url">-</span>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">${this.i18n.t('network.status')}</span>
                        <span class="detail-value" id="connection-status">-</span>
                    </div>
                </div>
            </div>
        `;

        this.addSwitcherStyles();
    }

    /**
     * Add CSS styles for network switcher
     */
    addSwitcherStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .network-switcher-container {
                background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                border-radius: 12px;
                padding: 16px;
                margin-bottom: 20px;
                border: 1px solid #333;
            }

            .network-buttons {
                display: flex;
                gap: 8px;
                margin-bottom: 16px;
            }

            .network-btn {
                flex: 1;
                background: rgba(255, 255, 255, 0.05);
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 8px;
                padding: 12px;
                color: #fff;
                cursor: pointer;
                transition: all 0.3s ease;
                display: flex;
                align-items: center;
                gap: 8px;
                position: relative;
            }

            .network-btn:hover {
                background: rgba(255, 255, 255, 0.1);
                border-color: rgba(255, 255, 255, 0.2);
                transform: translateY(-1px);
            }

            .network-btn.active {
                background: linear-gradient(135deg, #4a90e2 0%, #357abd 100%);
                border-color: #4a90e2;
                box-shadow: 0 4px 12px rgba(74, 144, 226, 0.3);
            }

            .network-btn.solana-btn.active {
                background: linear-gradient(135deg, #ff6b35 0%, #e55a2b 100%);
                border-color: #ff6b35;
                box-shadow: 0 4px 12px rgba(255, 107, 53, 0.3);
            }

            .network-icon {
                font-size: 20px;
                min-width: 24px;
            }

            .network-info {
                flex: 1;
                text-align: left;
            }

            .network-name {
                font-weight: 600;
                font-size: 14px;
                margin-bottom: 2px;
            }

            .network-purpose {
                font-size: 11px;
                opacity: 0.8;
                line-height: 1.3;
            }

            .network-status {
                position: relative;
            }

            .status-indicator {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: #666;
                transition: background 0.3s ease;
            }

            .status-indicator.connected {
                background: #4caf50;
                box-shadow: 0 0 8px rgba(76, 175, 80, 0.5);
            }

            .status-indicator.connecting {
                background: #ff9800;
                animation: pulse 1.5s infinite;
            }

            .status-indicator.error {
                background: #f44336;
            }

            .phase-indicator {
                background: rgba(255, 255, 255, 0.05);
                border-radius: 6px;
                padding: 8px 12px;
                margin-bottom: 12px;
                border: 1px solid rgba(255, 255, 255, 0.1);
            }

            .phase-info {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 12px;
            }

            .phase-label {
                color: #999;
            }

            .phase-number {
                background: #4a90e2;
                color: white;
                padding: 2px 6px;
                border-radius: 4px;
                font-weight: 600;
                font-size: 11px;
            }

            .phase-description {
                color: #ccc;
                flex: 1;
            }

            .network-details {
                display: flex;
                gap: 16px;
                font-size: 11px;
            }

            .detail-item {
                display: flex;
                flex-direction: column;
                gap: 2px;
            }

            .detail-label {
                color: #999;
                text-transform: uppercase;
                font-size: 10px;
            }

            .detail-value {
                color: #fff;
                font-family: monospace;
            }

            @keyframes pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.5; }
            }

            .network-btn.disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }

            .network-btn.disabled:hover {
                transform: none;
                background: rgba(255, 255, 255, 0.05);
            }
        `;
        document.head.appendChild(style);
    }

    /**
     * Bind event listeners
     */
    bindEvents() {
        const buttons = document.querySelectorAll('.network-btn');
        buttons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const network = e.currentTarget.dataset.network;
                this.switchNetwork(network);
            });
        });
    }

    /**
     * Switch to specified network
     */
    async switchNetwork(network) {
        try {
            // Update UI to show switching state
            this.setNetworkSwitching(network);

            // Switch network
            if (network === 'solana') {
                await this.networkManager.switchToSolana();
            } else if (network === 'qnet') {
                await this.networkManager.switchToQNet();
            }

            // Update UI
            this.currentNetwork = network;
            this.updateActiveNetwork();
            this.updateNetworkDetails();

            // Notify listeners
            this.notifyListeners('networkSwitched', { network });

        } catch (error) {
            console.error('Failed to switch network:', error);
            this.showNetworkError(network, error.message);
        }
    }

    /**
     * Update active network in UI
     */
    updateActiveNetwork() {
        const buttons = document.querySelectorAll('.network-btn');
        buttons.forEach(btn => {
            const network = btn.dataset.network;
            if (network === this.currentNetwork) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    }

    /**
     * Update network details display
     */
    updateNetworkDetails() {
        const rpcUrl = document.getElementById('rpc-url');
        const connectionStatus = document.getElementById('connection-status');
        
        const networkInfo = this.networkManager.getCurrentNetwork();
        
        if (rpcUrl) {
            rpcUrl.textContent = networkInfo.rpc || '-';
        }
        
        if (connectionStatus) {
            connectionStatus.textContent = networkInfo.connected ? 
                this.i18n.t('network.connected') : 
                this.i18n.t('network.disconnected');
        }
    }

    /**
     * Set network switching state
     */
    setNetworkSwitching(network) {
        const btn = document.querySelector(`[data-network="${network}"]`);
        const indicator = btn?.querySelector('.status-indicator');
        
        if (indicator) {
            indicator.className = 'status-indicator connecting';
        }
    }

    /**
     * Update network status indicators
     */
    updateNetworkStatus() {
        const solanaIndicator = document.querySelector('#solana-status .status-indicator');
        const qnetIndicator = document.querySelector('#qnet-status .status-indicator');
        
        const networkStatus = this.networkManager.getNetworkStatus();
        
        if (solanaIndicator) {
            solanaIndicator.className = `status-indicator ${
                networkStatus.networks.solana.connected ? 'connected' : 'error'
            }`;
        }
        
        if (qnetIndicator) {
            qnetIndicator.className = `status-indicator ${
                networkStatus.networks.qnet.connected ? 'connected' : 'error'
            }`;
        }
    }

    /**
     * Update phase information
     */
    updatePhaseInfo(phase) {
        this.phase = phase;
        
        const phaseNumber = document.getElementById('current-phase');
        const phaseDescription = document.getElementById('phase-description');
        
        if (phaseNumber) {
            phaseNumber.textContent = phase;
        }
        
        if (phaseDescription) {
            phaseDescription.textContent = phase === 1 ? 
                this.i18n.t('phase.phase1_description') : 
                this.i18n.t('phase.phase2_description');
        }
    }

    /**
     * Show network error
     */
    showNetworkError(network, message) {
        const btn = document.querySelector(`[data-network="${network}"]`);
        const indicator = btn?.querySelector('.status-indicator');
        
        if (indicator) {
            indicator.className = 'status-indicator error';
        }

        // Show error notification
        this.showNotification('error', `${this.i18n.t('network.switch_failed')}: ${message}`);
    }

    /**
     * Handle network events
     */
    handleNetworkEvent(event, data) {
        switch (event) {
            case 'networkChanged':
                this.currentNetwork = data.network;
                this.updateActiveNetwork();
                this.updateNetworkDetails();
                break;
                
            case 'initialized':
                this.phase = data.phase;
                this.updatePhaseInfo(this.phase);
                this.updateNetworkStatus();
                break;
                
            case 'configUpdated':
                this.updateNetworkDetails();
                break;
        }
    }

    /**
     * Show notification
     */
    showNotification(type, message) {
        // This would integrate with the main notification system
        console.log(`${type.toUpperCase()}: ${message}`);
    }

    /**
     * Add event listener
     */
    addListener(callback) {
        this.listeners.add(callback);
    }

    /**
     * Remove event listener
     */
    removeListener(callback) {
        this.listeners.delete(callback);
    }

    /**
     * Notify listeners
     */
    notifyListeners(event, data) {
        for (const listener of this.listeners) {
            try {
                listener(event, data);
            } catch (error) {
                console.error('Listener error:', error);
            }
        }
    }

    /**
     * Get current network
     */
    getCurrentNetwork() {
        return this.currentNetwork;
    }

    /**
     * Get current phase
     */
    getCurrentPhase() {
        return this.phase;
    }

    /**
     * Refresh network status
     */
    async refreshNetworkStatus() {
        try {
            await this.networkManager.initialize();
            this.updateNetworkStatus();
            this.updateNetworkDetails();
        } catch (error) {
            console.error('Failed to refresh network status:', error);
        }
    }

    /**
     * Enable/disable network switching
     */
    setNetworkSwitchingEnabled(enabled) {
        const buttons = document.querySelectorAll('.network-btn');
        buttons.forEach(btn => {
            if (enabled) {
                btn.classList.remove('disabled');
            } else {
                btn.classList.add('disabled');
            }
        });
    }

    /**
     * Destroy network switcher
     */
    destroy() {
        this.listeners.clear();
        const container = document.getElementById('network-switcher');
        if (container) {
            container.innerHTML = '';
        }
    }
} 