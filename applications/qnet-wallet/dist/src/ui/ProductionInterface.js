/**
 * Production Interface for QNet Wallet
 * Professional UI with polished design, animations, and comprehensive error handling
 */

export class ProductionInterface {
    constructor(dualWallet, i18n) {
        this.dualWallet = dualWallet;
        this.i18n = i18n;
        this.theme = 'dark'; // Default theme
        this.animations = true;
        this.notifications = [];
        this.loadingStates = new Map();
        
        this.init();
    }

    /**
     * Initialize production interface
     */
    init() {
        this.createMainInterface();
        this.addProductionStyles();
        this.bindEvents();
        this.startPeriodicUpdates();
        
        // Listen for wallet events
        this.dualWallet.addListener((event, data) => {
            this.handleWalletEvent(event, data);
        });
    }

    /**
     * Create main interface structure
     */
    createMainInterface() {
        const container = document.getElementById('wallet-interface');
        if (!container) return;

        container.innerHTML = `
            <div class="production-wallet-container">
                <!-- Header Section -->
                <header class="wallet-header">
                    <div class="header-content">
                        <div class="wallet-logo">
                            <div class="logo-icon">💎</div>
                            <div class="logo-text">
                                <div class="logo-title">QNet Wallet</div>
                                <div class="logo-subtitle">Dual-Network</div>
                            </div>
                        </div>
                        
                        <div class="header-actions">
                            <button class="header-btn" id="settings-btn" title="Settings">
                                <i class="icon-settings">⚙️</i>
                            </button>
                            <button class="header-btn" id="theme-toggle" title="Toggle Theme">
                                <i class="icon-theme">🌙</i>
                            </button>
                            <button class="header-btn" id="lock-wallet" title="Lock Wallet">
                                <i class="icon-lock">🔒</i>
                            </button>
                        </div>
                    </div>
                </header>

                <!-- Network Status Bar -->
                <div class="network-status-bar" id="network-status-bar">
                    <div class="network-indicator">
                        <div class="network-icon" id="network-icon">🔥</div>
                        <div class="network-info">
                            <div class="network-name" id="network-name">Solana Network</div>
                            <div class="network-status" id="network-status">Connected</div>
                        </div>
                    </div>
                    
                    <div class="phase-indicator">
                        <div class="phase-badge" id="phase-badge">Phase 1</div>
                        <div class="phase-progress" id="phase-progress">
                            <div class="progress-bar">
                                <div class="progress-fill" id="progress-fill" style="width: 25%"></div>
                            </div>
                            <div class="progress-text">25% burned</div>
                        </div>
                    </div>
                </div>

                <!-- Main Content Area -->
                <main class="wallet-main">
                    <!-- Balance Section -->
                    <section class="balance-section">
                        <div class="balance-cards" id="balance-cards">
                            <!-- Dynamic balance cards -->
                        </div>
                    </section>

                    <!-- Action Section -->
                    <section class="action-section">
                        <div class="action-tabs" id="action-tabs">
                            <button class="action-tab active" data-tab="activate">
                                <i class="tab-icon">⚡</i>
                                <span>Activate Node</span>
                            </button>
                            <button class="action-tab" data-tab="manage">
                                <i class="tab-icon">📊</i>
                                <span>Manage</span>
                            </button>
                            <button class="action-tab" data-tab="transfer">
                                <i class="tab-icon">🔄</i>
                                <span>Transfer</span>
                            </button>
                        </div>
                        
                        <div class="action-content" id="action-content">
                            <!-- Dynamic action content -->
                        </div>
                    </section>

                    <!-- Activity Section -->
                    <section class="activity-section">
                        <div class="section-header">
                            <h3>Recent Activity</h3>
                            <button class="refresh-btn" id="refresh-activity">
                                <i class="icon-refresh">🔄</i>
                            </button>
                        </div>
                        <div class="activity-list" id="activity-list">
                            <!-- Dynamic activity items -->
                        </div>
                    </section>
                </main>

                <!-- Notifications -->
                <div class="notifications-container" id="notifications-container">
                    <!-- Dynamic notifications -->
                </div>

                <!-- Loading Overlay -->
                <div class="loading-overlay" id="loading-overlay" style="display: none;">
                    <div class="loading-content">
                        <div class="loading-spinner"></div>
                        <div class="loading-text" id="loading-text">Processing...</div>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Add production-grade CSS styles
     */
    addProductionStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .production-wallet-container {
                min-height: 100vh;
                background: linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 50%, #16213e 100%);
                color: #ffffff;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                overflow-x: hidden;
            }

            .wallet-header {
                background: rgba(255, 255, 255, 0.05);
                backdrop-filter: blur(20px);
                border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                padding: 16px 24px;
                position: sticky;
                top: 0;
                z-index: 100;
            }

            .header-content {
                display: flex;
                justify-content: space-between;
                align-items: center;
                max-width: 1200px;
                margin: 0 auto;
            }

            .wallet-logo {
                display: flex;
                align-items: center;
                gap: 12px;
            }

            .logo-icon {
                font-size: 32px;
                background: linear-gradient(135deg, #4a90e2, #357abd);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
                background-clip: text;
            }

            .logo-title {
                font-size: 20px;
                font-weight: 700;
                background: linear-gradient(135deg, #ffffff, #e0e0e0);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
                background-clip: text;
            }

            .logo-subtitle {
                font-size: 12px;
                color: #888;
                font-weight: 500;
            }

            .header-actions {
                display: flex;
                gap: 8px;
            }

            .header-btn {
                background: rgba(255, 255, 255, 0.1);
                border: 1px solid rgba(255, 255, 255, 0.2);
                border-radius: 8px;
                padding: 8px;
                color: #fff;
                cursor: pointer;
                transition: all 0.3s ease;
                font-size: 16px;
            }

            .header-btn:hover {
                background: rgba(255, 255, 255, 0.2);
                transform: translateY(-1px);
            }

            .network-status-bar {
                background: rgba(255, 255, 255, 0.03);
                border-bottom: 1px solid rgba(255, 255, 255, 0.05);
                padding: 12px 24px;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }

            .network-indicator {
                display: flex;
                align-items: center;
                gap: 12px;
            }

            .network-icon {
                font-size: 20px;
                padding: 8px;
                background: rgba(255, 107, 53, 0.2);
                border-radius: 8px;
            }

            .network-name {
                font-weight: 600;
                font-size: 14px;
            }

            .network-status {
                font-size: 12px;
                color: #4caf50;
            }

            .phase-indicator {
                display: flex;
                align-items: center;
                gap: 12px;
            }

            .phase-badge {
                background: linear-gradient(135deg, #4a90e2, #357abd);
                padding: 4px 12px;
                border-radius: 12px;
                font-size: 12px;
                font-weight: 600;
            }

            .phase-progress {
                display: flex;
                align-items: center;
                gap: 8px;
            }

            .progress-bar {
                width: 100px;
                height: 4px;
                background: rgba(255, 255, 255, 0.2);
                border-radius: 2px;
                overflow: hidden;
            }

            .progress-fill {
                height: 100%;
                background: linear-gradient(90deg, #ff6b35, #e55a2b);
                border-radius: 2px;
                transition: width 0.3s ease;
            }

            .progress-text {
                font-size: 11px;
                color: #ccc;
            }

            .wallet-main {
                max-width: 1200px;
                margin: 0 auto;
                padding: 24px;
                display: grid;
                gap: 24px;
            }

            .balance-section {
                background: rgba(255, 255, 255, 0.05);
                border-radius: 16px;
                padding: 24px;
                border: 1px solid rgba(255, 255, 255, 0.1);
            }

            .balance-cards {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 16px;
            }

            .balance-card {
                background: linear-gradient(135deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.05));
                border-radius: 12px;
                padding: 20px;
                border: 1px solid rgba(255, 255, 255, 0.15);
                transition: all 0.3s ease;
            }

            .balance-card:hover {
                transform: translateY(-2px);
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
            }

            .balance-token {
                display: flex;
                align-items: center;
                gap: 8px;
                margin-bottom: 8px;
            }

            .token-icon {
                font-size: 20px;
            }

            .token-name {
                font-weight: 600;
                font-size: 14px;
            }

            .balance-amount {
                font-size: 24px;
                font-weight: 700;
                margin-bottom: 4px;
            }

            .balance-usd {
                font-size: 12px;
                color: #888;
            }

            .action-section {
                background: rgba(255, 255, 255, 0.05);
                border-radius: 16px;
                border: 1px solid rgba(255, 255, 255, 0.1);
                overflow: hidden;
            }

            .action-tabs {
                display: flex;
                background: rgba(255, 255, 255, 0.05);
                border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            }

            .action-tab {
                flex: 1;
                background: none;
                border: none;
                padding: 16px;
                color: #ccc;
                cursor: pointer;
                transition: all 0.3s ease;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 8px;
                font-weight: 500;
            }

            .action-tab.active {
                background: rgba(74, 144, 226, 0.2);
                color: #4a90e2;
                border-bottom: 2px solid #4a90e2;
            }

            .action-tab:hover:not(.active) {
                background: rgba(255, 255, 255, 0.1);
                color: #fff;
            }

            .action-content {
                padding: 24px;
                min-height: 300px;
            }

            .activity-section {
                background: rgba(255, 255, 255, 0.05);
                border-radius: 16px;
                padding: 24px;
                border: 1px solid rgba(255, 255, 255, 0.1);
            }

            .section-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 16px;
            }

            .section-header h3 {
                margin: 0;
                font-size: 18px;
                font-weight: 600;
            }

            .refresh-btn {
                background: rgba(255, 255, 255, 0.1);
                border: 1px solid rgba(255, 255, 255, 0.2);
                border-radius: 6px;
                padding: 6px;
                color: #fff;
                cursor: pointer;
                transition: all 0.3s ease;
            }

            .refresh-btn:hover {
                background: rgba(255, 255, 255, 0.2);
                transform: rotate(180deg);
            }

            .activity-list {
                display: flex;
                flex-direction: column;
                gap: 12px;
            }

            .activity-item {
                background: rgba(255, 255, 255, 0.05);
                border-radius: 8px;
                padding: 16px;
                border: 1px solid rgba(255, 255, 255, 0.1);
                display: flex;
                justify-content: space-between;
                align-items: center;
                transition: all 0.3s ease;
            }

            .activity-item:hover {
                background: rgba(255, 255, 255, 0.1);
            }

            .activity-info {
                display: flex;
                align-items: center;
                gap: 12px;
            }

            .activity-icon {
                font-size: 20px;
                padding: 8px;
                background: rgba(74, 144, 226, 0.2);
                border-radius: 6px;
            }

            .activity-details {
                display: flex;
                flex-direction: column;
                gap: 2px;
            }

            .activity-title {
                font-weight: 600;
                font-size: 14px;
            }

            .activity-subtitle {
                font-size: 12px;
                color: #888;
            }

            .activity-amount {
                font-weight: 600;
                text-align: right;
            }

            .notifications-container {
                position: fixed;
                top: 20px;
                right: 20px;
                z-index: 1000;
                display: flex;
                flex-direction: column;
                gap: 12px;
                max-width: 400px;
            }

            .notification {
                background: rgba(0, 0, 0, 0.9);
                backdrop-filter: blur(20px);
                border-radius: 12px;
                padding: 16px;
                border-left: 4px solid #4a90e2;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
                animation: slideInRight 0.3s ease;
            }

            .notification.success {
                border-left-color: #4caf50;
            }

            .notification.warning {
                border-left-color: #ff9800;
            }

            .notification.error {
                border-left-color: #f44336;
            }

            .notification-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 8px;
            }

            .notification-title {
                font-weight: 600;
                font-size: 14px;
            }

            .notification-close {
                background: none;
                border: none;
                color: #888;
                cursor: pointer;
                font-size: 16px;
            }

            .notification-message {
                font-size: 13px;
                color: #ccc;
                line-height: 1.4;
            }

            .loading-overlay {
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.8);
                backdrop-filter: blur(10px);
                display: flex;
                justify-content: center;
                align-items: center;
                z-index: 9999;
            }

            .loading-content {
                background: rgba(255, 255, 255, 0.1);
                border-radius: 16px;
                padding: 32px;
                text-align: center;
                border: 1px solid rgba(255, 255, 255, 0.2);
            }

            .loading-spinner {
                width: 40px;
                height: 40px;
                border: 3px solid rgba(255, 255, 255, 0.3);
                border-top: 3px solid #4a90e2;
                border-radius: 50%;
                animation: spin 1s linear infinite;
                margin: 0 auto 16px;
            }

            .loading-text {
                font-size: 16px;
                font-weight: 500;
            }

            @keyframes slideInRight {
                from {
                    transform: translateX(100%);
                    opacity: 0;
                }
                to {
                    transform: translateX(0);
                    opacity: 1;
                }
            }

            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }

            @keyframes fadeIn {
                from { opacity: 0; transform: translateY(10px); }
                to { opacity: 1; transform: translateY(0); }
            }

            .fade-in {
                animation: fadeIn 0.3s ease;
            }

            /* Responsive design */
            @media (max-width: 768px) {
                .wallet-main {
                    padding: 16px;
                    gap: 16px;
                }

                .balance-cards {
                    grid-template-columns: 1fr;
                }

                .action-tabs {
                    flex-direction: column;
                }

                .notifications-container {
                    left: 20px;
                    right: 20px;
                    max-width: none;
                }
            }

            /* Dark theme variations */
            .theme-dark .production-wallet-container {
                background: linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 50%, #16213e 100%);
            }

            .theme-light .production-wallet-container {
                background: linear-gradient(135deg, #f5f5f5 0%, #e0e0e0 50%, #d0d0d0 100%);
                color: #333;
            }
        `;
        document.head.appendChild(style);
    }

    /**
     * Update balance cards with current wallet state
     */
    async updateBalanceCards() {
        const balanceCards = document.getElementById('balance-cards');
        if (!balanceCards) return;

        try {
            const walletState = this.dualWallet.getWalletState();
            if (walletState.locked) {
                balanceCards.innerHTML = '<div class="balance-card locked">Wallet Locked</div>';
                return;
            }

            const currentNetwork = walletState.currentNetwork;
            const balances = walletState.balances[currentNetwork];
            
            let cardsHtml = '';

            if (currentNetwork === 'solana') {
                cardsHtml += this.createBalanceCard('SOL', balances.SOL || 0, '☀️');
                cardsHtml += this.createBalanceCard('1DEV', balances['1DEV'] || 0, '🔥');
            } else {
                cardsHtml += this.createBalanceCard('QNC', balances.QNC || 0, '💎');
            }

            balanceCards.innerHTML = cardsHtml;

        } catch (error) {
            console.error('Failed to update balance cards:', error);
            this.showNotification('error', 'Failed to load balances', error.message);
        }
    }

    /**
     * Create balance card HTML
     */
    createBalanceCard(token, amount, icon) {
        const formattedAmount = this.formatAmount(amount);
        const usdValue = this.calculateUSDValue(token, amount);

        return `
            <div class="balance-card fade-in">
                <div class="balance-token">
                    <span class="token-icon">${icon}</span>
                    <span class="token-name">${token}</span>
                </div>
                <div class="balance-amount">${formattedAmount}</div>
                <div class="balance-usd">≈ $${usdValue}</div>
            </div>
        `;
    }

    /**
     * Format amount for display
     */
    formatAmount(amount) {
        if (amount === 0) return '0';
        if (amount < 0.001) return '<0.001';
        if (amount < 1) return amount.toFixed(6);
        if (amount < 1000) return amount.toFixed(3);
        if (amount < 1000000) return (amount / 1000).toFixed(1) + 'K';
        return (amount / 1000000).toFixed(1) + 'M';
    }

    /**
     * Calculate USD value (mock implementation)
     */
    calculateUSDValue(token, amount) {
        const prices = {
            'SOL': 100,
            '1DEV': 0.01,
            'QNC': 0.05
        };
        
        const price = prices[token] || 0;
        const usdValue = amount * price;
        
        if (usdValue < 0.01) return '0.00';
        if (usdValue < 1) return usdValue.toFixed(4);
        return usdValue.toFixed(2);
    }

    /**
     * Show notification with professional styling
     */
    showNotification(type, title, message, duration = 5000) {
        const container = document.getElementById('notifications-container');
        if (!container) return;

        const notificationId = `notification-${Date.now()}`;
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        notification.id = notificationId;
        
        notification.innerHTML = `
            <div class="notification-header">
                <div class="notification-title">${title}</div>
                <button class="notification-close" onclick="this.parentElement.parentElement.remove()">✕</button>
            </div>
            <div class="notification-message">${message}</div>
        `;

        container.appendChild(notification);

        // Auto-remove after duration
        setTimeout(() => {
            const element = document.getElementById(notificationId);
            if (element) {
                element.style.animation = 'slideInRight 0.3s ease reverse';
                setTimeout(() => element.remove(), 300);
            }
        }, duration);

        this.notifications.push({
            id: notificationId,
            type,
            title,
            message,
            timestamp: Date.now()
        });
    }

    /**
     * Show loading overlay
     */
    showLoading(text = 'Processing...') {
        const overlay = document.getElementById('loading-overlay');
        const loadingText = document.getElementById('loading-text');
        
        if (overlay) {
            overlay.style.display = 'flex';
            if (loadingText) loadingText.textContent = text;
        }
    }

    /**
     * Hide loading overlay
     */
    hideLoading() {
        const overlay = document.getElementById('loading-overlay');
        if (overlay) {
            overlay.style.display = 'none';
        }
    }

    /**
     * Handle wallet events
     */
    handleWalletEvent(event, data) {
        switch (event) {
            case 'walletUnlocked':
                this.updateBalanceCards();
                this.showNotification('success', 'Wallet Unlocked', 'Welcome back!');
                break;
                
            case 'walletLocked':
                this.updateBalanceCards();
                this.showNotification('info', 'Wallet Locked', 'Wallet has been locked for security');
                break;
                
            case 'networkSwitched':
                this.updateNetworkStatus(data.network);
                this.updateBalanceCards();
                this.showNotification('info', 'Network Switched', `Switched to ${data.network.toUpperCase()}`);
                break;
                
            case 'nodeActivated':
                this.showNotification('success', 'Node Activated', `${data.nodeType} node activated successfully`);
                this.updateBalanceCards();
                break;
                
            case 'balancesUpdated':
                this.updateBalanceCards();
                break;
                
            default:
                console.log('Unhandled wallet event:', event, data);
        }
    }

    /**
     * Update network status display
     */
    updateNetworkStatus(network) {
        const networkIcon = document.getElementById('network-icon');
        const networkName = document.getElementById('network-name');
        
        if (networkIcon && networkName) {
            if (network === 'solana') {
                networkIcon.textContent = '🔥';
                networkName.textContent = 'Solana Network';
            } else {
                networkIcon.textContent = '💎';
                networkName.textContent = 'QNet Network';
            }
        }
    }

    /**
     * Bind event listeners
     */
    bindEvents() {
        // Theme toggle
        const themeToggle = document.getElementById('theme-toggle');
        if (themeToggle) {
            themeToggle.addEventListener('click', () => this.toggleTheme());
        }

        // Lock wallet
        const lockWallet = document.getElementById('lock-wallet');
        if (lockWallet) {
            lockWallet.addEventListener('click', () => this.dualWallet.lockWallet());
        }

        // Refresh activity
        const refreshActivity = document.getElementById('refresh-activity');
        if (refreshActivity) {
            refreshActivity.addEventListener('click', () => this.refreshActivity());
        }

        // Action tabs
        const actionTabs = document.querySelectorAll('.action-tab');
        actionTabs.forEach(tab => {
            tab.addEventListener('click', (e) => {
                const tabName = e.currentTarget.dataset.tab;
                this.switchActionTab(tabName);
            });
        });
    }

    /**
     * Toggle theme
     */
    toggleTheme() {
        this.theme = this.theme === 'dark' ? 'light' : 'dark';
        document.body.className = `theme-${this.theme}`;
        
        const themeIcon = document.querySelector('#theme-toggle .icon-theme');
        if (themeIcon) {
            themeIcon.textContent = this.theme === 'dark' ? '🌙' : '☀️';
        }
    }

    /**
     * Switch action tab
     */
    switchActionTab(tabName) {
        // Update tab appearance
        const tabs = document.querySelectorAll('.action-tab');
        tabs.forEach(tab => {
            if (tab.dataset.tab === tabName) {
                tab.classList.add('active');
            } else {
                tab.classList.remove('active');
            }
        });

        // Update content
        const content = document.getElementById('action-content');
        if (content) {
            switch (tabName) {
                case 'activate':
                    content.innerHTML = this.createActivateContent();
                    break;
                case 'manage':
                    content.innerHTML = this.createManageContent();
                    break;
                case 'transfer':
                    content.innerHTML = this.createTransferContent();
                    break;
            }
        }
    }

    /**
     * Create activate tab content
     */
    createActivateContent() {
        return `
            <div class="activate-content">
                <h3>Activate QNet Node</h3>
                <p>Choose your node type and activate on the current network.</p>
                
                <div class="node-type-grid">
                    <div class="node-type-card" data-type="light">
                        <div class="node-icon">⚡</div>
                        <div class="node-title">Light Node</div>
                        <div class="node-description">Mobile-friendly, low resource usage</div>
                        <div class="node-cost">Cost: Dynamic</div>
                    </div>
                    
                    <div class="node-type-card" data-type="full">
                        <div class="node-icon">🔥</div>
                        <div class="node-title">Full Node</div>
                        <div class="node-description">Desktop/server, full validation</div>
                        <div class="node-cost">Cost: Dynamic</div>
                    </div>
                    
                    <div class="node-type-card" data-type="super">
                        <div class="node-icon">⚡</div>
                        <div class="node-title">Super Node</div>
                        <div class="node-description">High-performance, maximum rewards</div>
                        <div class="node-cost">Cost: Dynamic</div>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Create manage tab content
     */
    createManageContent() {
        return `
            <div class="manage-content">
                <h3>Manage Your Node</h3>
                <p>Monitor and manage your active QNet node.</p>
                
                <div class="node-status-card">
                    <div class="status-header">
                        <div class="status-icon">💎</div>
                        <div class="status-info">
                            <div class="status-title">Node Status</div>
                            <div class="status-subtitle">Check your node information</div>
                        </div>
                    </div>
                    
                    <div class="status-actions">
                        <button class="action-btn primary">Check Status</button>
                        <button class="action-btn secondary">View Rewards</button>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Create transfer tab content
     */
    createTransferContent() {
        return `
            <div class="transfer-content">
                <h3>Transfer Node</h3>
                <p>Transfer your node ownership to another wallet.</p>
                
                <div class="transfer-form">
                    <div class="form-group">
                        <label>Destination Address</label>
                        <input type="text" class="form-input" placeholder="Enter QNet address">
                    </div>
                    
                    <div class="form-actions">
                        <button class="action-btn primary">Transfer Node</button>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Refresh activity
     */
    async refreshActivity() {
        try {
            this.showLoading('Refreshing activity...');
            
            // Simulate API call
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            this.hideLoading();
            this.showNotification('success', 'Refreshed', 'Activity updated successfully');
            
        } catch (error) {
            this.hideLoading();
            this.showNotification('error', 'Refresh Failed', error.message);
        }
    }

    /**
     * Start periodic updates
     */
    startPeriodicUpdates() {
        // Update balances every 30 seconds
        setInterval(() => {
            if (!this.dualWallet.getWalletState().locked) {
                this.updateBalanceCards();
            }
        }, 30000);

        // Update network status every 60 seconds
        setInterval(() => {
            // Update network status indicators
        }, 60000);
    }

    /**
     * Get interface statistics
     */
    getInterfaceStats() {
        return {
            theme: this.theme,
            notifications: this.notifications.length,
            loadingStates: this.loadingStates.size,
            lastUpdate: Date.now()
        };
    }

    /**
     * Destroy interface
     */
    destroy() {
        this.notifications = [];
        this.loadingStates.clear();
        
        const container = document.getElementById('wallet-interface');
        if (container) {
            container.innerHTML = '';
        }
    }
} 