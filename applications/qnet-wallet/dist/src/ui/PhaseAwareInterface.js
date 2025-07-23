/**
 * Phase-Aware Interface for QNet Wallet
 * Dynamically adapts UI based on current network phase and network selection
 */

export class PhaseAwareInterface {
    constructor(dualNetworkManager, i18n) {
        this.networkManager = dualNetworkManager;
        this.i18n = i18n;
        this.currentPhase = 1;
        this.currentNetwork = 'solana';
        this.interfaceMode = 'phase1_solana';
        
        this.init();
    }

    /**
     * Initialize phase-aware interface
     */
    init() {
        this.createInterfaceContainer();
        this.bindEvents();
        this.updateInterface();
        
        // Listen for network and phase changes
        this.networkManager.addListener((event, data) => {
            this.handleNetworkEvent(event, data);
        });
    }

    /**
     * Create main interface container
     */
    createInterfaceContainer() {
        const container = document.getElementById('phase-interface');
        if (!container) return;

        container.innerHTML = `
            <div class="phase-interface-container">
                <div class="interface-header">
                    <div class="mode-indicator" id="mode-indicator">
                        <span class="mode-icon" id="mode-icon">🔥</span>
                        <span class="mode-text" id="mode-text">Phase 1 - Solana Network</span>
                    </div>
                </div>
                
                <div class="interface-content" id="interface-content">
                    <!-- Dynamic content based on phase and network -->
                </div>
                
                <div class="interface-actions" id="interface-actions">
                    <!-- Dynamic actions based on current mode -->
                </div>
            </div>
        `;

        this.addInterfaceStyles();
    }

    /**
     * Add CSS styles for phase-aware interface
     */
    addInterfaceStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .phase-interface-container {
                background: linear-gradient(135deg, #0f0f23 0%, #1a1a2e 100%);
                border-radius: 12px;
                padding: 20px;
                margin-bottom: 20px;
                border: 1px solid #333;
                min-height: 400px;
            }

            .interface-header {
                margin-bottom: 20px;
                padding-bottom: 16px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            }

            .mode-indicator {
                display: flex;
                align-items: center;
                gap: 12px;
                font-size: 16px;
                font-weight: 600;
                color: #fff;
            }

            .mode-icon {
                font-size: 24px;
                padding: 8px;
                background: rgba(255, 255, 255, 0.1);
                border-radius: 8px;
            }

            .mode-text {
                background: linear-gradient(135deg, #4a90e2, #357abd);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
                background-clip: text;
            }

            .interface-content {
                margin-bottom: 20px;
                min-height: 250px;
            }

            .content-section {
                background: rgba(255, 255, 255, 0.05);
                border-radius: 8px;
                padding: 16px;
                margin-bottom: 16px;
                border: 1px solid rgba(255, 255, 255, 0.1);
            }

            .section-title {
                font-size: 14px;
                font-weight: 600;
                color: #fff;
                margin-bottom: 12px;
                display: flex;
                align-items: center;
                gap: 8px;
            }

            .section-content {
                color: #ccc;
                line-height: 1.5;
            }

            .action-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 12px;
            }

            .action-card {
                background: rgba(255, 255, 255, 0.05);
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 8px;
                padding: 16px;
                cursor: pointer;
                transition: all 0.3s ease;
                text-align: center;
            }

            .action-card:hover {
                background: rgba(255, 255, 255, 0.1);
                border-color: rgba(255, 255, 255, 0.2);
                transform: translateY(-2px);
            }

            .action-card.primary {
                background: linear-gradient(135deg, #4a90e2 0%, #357abd 100%);
                border-color: #4a90e2;
            }

            .action-card.primary:hover {
                box-shadow: 0 6px 20px rgba(74, 144, 226, 0.3);
            }

            .action-card.solana {
                background: linear-gradient(135deg, #ff6b35 0%, #e55a2b 100%);
                border-color: #ff6b35;
            }

            .action-card.solana:hover {
                box-shadow: 0 6px 20px rgba(255, 107, 53, 0.3);
            }

            .action-icon {
                font-size: 32px;
                margin-bottom: 8px;
            }

            .action-title {
                font-weight: 600;
                color: #fff;
                margin-bottom: 4px;
            }

            .action-description {
                font-size: 12px;
                color: rgba(255, 255, 255, 0.8);
                line-height: 1.3;
            }

            .cost-display {
                background: rgba(0, 0, 0, 0.3);
                border-radius: 4px;
                padding: 4px 8px;
                margin-top: 8px;
                font-size: 11px;
                color: #4caf50;
                font-weight: 600;
            }

            .phase-transition-notice {
                background: linear-gradient(135deg, #ff9800 0%, #f57c00 100%);
                border-radius: 8px;
                padding: 16px;
                margin-bottom: 16px;
                color: #fff;
                text-align: center;
            }

            .transition-title {
                font-weight: 600;
                margin-bottom: 8px;
            }

            .transition-progress {
                background: rgba(255, 255, 255, 0.2);
                border-radius: 10px;
                height: 6px;
                margin: 8px 0;
                overflow: hidden;
            }

            .transition-progress-bar {
                background: #fff;
                height: 100%;
                transition: width 0.3s ease;
            }

            .network-info {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
                gap: 12px;
                margin-bottom: 16px;
            }

            .info-item {
                background: rgba(255, 255, 255, 0.05);
                border-radius: 6px;
                padding: 12px;
                text-align: center;
            }

            .info-label {
                font-size: 11px;
                color: #999;
                text-transform: uppercase;
                margin-bottom: 4px;
            }

            .info-value {
                font-size: 14px;
                font-weight: 600;
                color: #fff;
            }

            .disabled {
                opacity: 0.5;
                cursor: not-allowed !important;
            }

            .disabled:hover {
                transform: none !important;
                box-shadow: none !important;
            }
        `;
        document.head.appendChild(style);
    }

    /**
     * Update interface based on current phase and network
     */
    async updateInterface() {
        try {
            // Determine interface mode
            this.interfaceMode = this.determineInterfaceMode();
            
            // Update mode indicator
            this.updateModeIndicator();
            
            // Update content based on mode
            await this.updateContent();
            
            // Update actions
            await this.updateActions();
            
        } catch (error) {
            console.error('Failed to update interface:', error);
        }
    }

    /**
     * Determine current interface mode
     */
    determineInterfaceMode() {
        if (this.currentPhase === 1 && this.currentNetwork === 'solana') {
            return 'phase1_solana';
        } else if (this.currentPhase === 1 && this.currentNetwork === 'qnet') {
            return 'phase1_qnet';
        } else if (this.currentPhase === 2 && this.currentNetwork === 'solana') {
            return 'phase2_solana';
        } else if (this.currentPhase === 2 && this.currentNetwork === 'qnet') {
            return 'phase2_qnet';
        }
        return 'phase1_solana'; // Default
    }

    /**
     * Update mode indicator
     */
    updateModeIndicator() {
        const modeIcon = document.getElementById('mode-icon');
        const modeText = document.getElementById('mode-text');
        
        const modeConfig = {
            'phase1_solana': {
                icon: '🔥',
                text: this.i18n.t('interface.phase1_solana_mode'),
                class: 'solana'
            },
            'phase1_qnet': {
                icon: '💎',
                text: this.i18n.t('interface.phase1_qnet_mode'),
                class: 'qnet'
            },
            'phase2_solana': {
                icon: '🔥',
                text: this.i18n.t('interface.phase2_solana_mode'),
                class: 'solana'
            },
            'phase2_qnet': {
                icon: '💎',
                text: this.i18n.t('interface.phase2_qnet_mode'),
                class: 'qnet'
            }
        };

        const config = modeConfig[this.interfaceMode];
        if (modeIcon) modeIcon.textContent = config.icon;
        if (modeText) modeText.textContent = config.text;
    }

    /**
     * Update content based on current mode
     */
    async updateContent() {
        const contentContainer = document.getElementById('interface-content');
        if (!contentContainer) return;

        switch (this.interfaceMode) {
            case 'phase1_solana':
                contentContainer.innerHTML = await this.createPhase1SolanaContent();
                break;
            case 'phase1_qnet':
                contentContainer.innerHTML = await this.createPhase1QNetContent();
                break;
            case 'phase2_solana':
                contentContainer.innerHTML = await this.createPhase2SolanaContent();
                break;
            case 'phase2_qnet':
                contentContainer.innerHTML = await this.createPhase2QNetContent();
                break;
        }
    }

    /**
     * Create Phase 1 Solana content
     */
    async createPhase1SolanaContent() {
        const burnProgress = await this.getBurnProgress();
        
        return `
            <div class="content-section">
                <div class="section-title">
                    🔥 ${this.i18n.t('phase1.burn_activation')}
                </div>
                <div class="section-content">
                    <p>${this.i18n.t('phase1.solana_description')}</p>
                    
                    <div class="network-info">
                        <div class="info-item">
                            <div class="info-label">${this.i18n.t('burn.progress')}</div>
                            <div class="info-value">${burnProgress.percentage}%</div>
                        </div>
                        <div class="info-item">
                            <div class="info-label">${this.i18n.t('burn.current_cost')}</div>
                            <div class="info-value">${burnProgress.currentCost} 1DEV</div>
                        </div>
                        <div class="info-item">
                            <div class="info-label">${this.i18n.t('burn.savings')}</div>
                            <div class="info-value">${burnProgress.savings} 1DEV</div>
                        </div>
                    </div>
                    
                    <div class="transition-progress">
                        <div class="transition-progress-bar" style="width: ${burnProgress.percentage}%"></div>
                    </div>
                    
                    <p class="section-content">
                        ${this.i18n.t('phase1.burn_explanation')}
                    </p>
                </div>
            </div>
        `;
    }

    /**
     * Create Phase 1 QNet content
     */
    async createPhase1QNetContent() {
        return `
            <div class="content-section">
                <div class="section-title">
                    💎 ${this.i18n.t('phase1.node_management')}
                </div>
                <div class="section-content">
                    <p>${this.i18n.t('phase1.qnet_description')}</p>
                    
                    <div class="network-info">
                        <div class="info-item">
                            <div class="info-label">${this.i18n.t('node.total_nodes')}</div>
                            <div class="info-value">-</div>
                        </div>
                        <div class="info-item">
                            <div class="info-label">${this.i18n.t('node.your_nodes')}</div>
                            <div class="info-value">0</div>
                        </div>
                    </div>
                    
                    <p class="section-content">
                        ${this.i18n.t('phase1.activation_code_info')}
                    </p>
                </div>
            </div>
        `;
    }

    /**
     * Create Phase 2 Solana content
     */
    async createPhase2SolanaContent() {
        return `
            <div class="phase-transition-notice">
                <div class="transition-title">
                    ${this.i18n.t('phase2.transition_complete')}
                </div>
                <p>${this.i18n.t('phase2.solana_limited_role')}</p>
            </div>
            
            <div class="content-section">
                <div class="section-title">
                    ⚠️ ${this.i18n.t('phase2.legacy_network')}
                </div>
                <div class="section-content">
                    <p>${this.i18n.t('phase2.switch_to_qnet_recommendation')}</p>
                </div>
            </div>
        `;
    }

    /**
     * Create Phase 2 QNet content
     */
    async createPhase2QNetContent() {
        const activationCosts = await this.getActivationCosts();
        
        return `
            <div class="phase-transition-notice">
                <div class="transition-title">
                    ${this.i18n.t('phase2.native_activation')}
                </div>
                <p>${this.i18n.t('phase2.qnc_pool3_mechanism')}</p>
            </div>
            
            <div class="content-section">
                <div class="section-title">
                    💎 ${this.i18n.t('phase2.qnc_activation')}
                </div>
                <div class="section-content">
                    <p>${this.i18n.t('phase2.qnc_description')}</p>
                    
                    <div class="network-info">
                        <div class="info-item">
                            <div class="info-label">${this.i18n.t('node.light_cost')}</div>
                            <div class="info-value">${activationCosts.light.toLocaleString()} QNC</div>
                        </div>
                        <div class="info-item">
                            <div class="info-label">${this.i18n.t('node.full_cost')}</div>
                            <div class="info-value">${activationCosts.full.toLocaleString()} QNC</div>
                        </div>
                        <div class="info-item">
                            <div class="info-label">${this.i18n.t('node.super_cost')}</div>
                            <div class="info-value">${activationCosts.super.toLocaleString()} QNC</div>
                        </div>
                    </div>
                    
                    <p class="section-content">
                        ${this.i18n.t('phase2.pool3_explanation')}
                    </p>
                </div>
            </div>
        `;
    }

    /**
     * Update actions based on current mode
     */
    async updateActions() {
        const actionsContainer = document.getElementById('interface-actions');
        if (!actionsContainer) return;

        switch (this.interfaceMode) {
            case 'phase1_solana':
                actionsContainer.innerHTML = await this.createPhase1SolanaActions();
                break;
            case 'phase1_qnet':
                actionsContainer.innerHTML = await this.createPhase1QNetActions();
                break;
            case 'phase2_solana':
                actionsContainer.innerHTML = await this.createPhase2SolanaActions();
                break;
            case 'phase2_qnet':
                actionsContainer.innerHTML = await this.createPhase2QNetActions();
                break;
        }

        this.bindActionEvents();
    }

    /**
     * Create Phase 1 Solana actions
     */
    async createPhase1SolanaActions() {
        const burnProgress = await this.getBurnProgress();
        
        return `
            <div class="action-grid">
                <div class="action-card solana primary" data-action="burn-light">
                    <div class="action-icon">⚡</div>
                    <div class="action-title">${this.i18n.t('node.light_node')}</div>
                    <div class="action-description">${this.i18n.t('node.light_description')}</div>
                    <div class="cost-display">${burnProgress.currentCost} 1DEV</div>
                </div>
                
                <div class="action-card solana primary" data-action="burn-full">
                    <div class="action-icon">🔥</div>
                    <div class="action-title">${this.i18n.t('node.full_node')}</div>
                    <div class="action-description">${this.i18n.t('node.full_description')}</div>
                    <div class="cost-display">${burnProgress.currentCost} 1DEV</div>
                </div>
                
                <div class="action-card solana primary" data-action="burn-super">
                    <div class="action-icon">⚡</div>
                    <div class="action-title">${this.i18n.t('node.super_node')}</div>
                    <div class="action-description">${this.i18n.t('node.super_description')}</div>
                    <div class="cost-display">${burnProgress.currentCost} 1DEV</div>
                </div>
            </div>
        `;
    }

    /**
     * Create Phase 1 QNet actions
     */
    async createPhase1QNetActions() {
        return `
            <div class="action-grid">
                <div class="action-card primary" data-action="activate-with-code">
                    <div class="action-icon">🔑</div>
                    <div class="action-title">${this.i18n.t('activation.use_code')}</div>
                    <div class="action-description">${this.i18n.t('activation.code_description')}</div>
                </div>
                
                <div class="action-card" data-action="check-node-status">
                    <div class="action-icon">📊</div>
                    <div class="action-title">${this.i18n.t('node.check_status')}</div>
                    <div class="action-description">${this.i18n.t('node.status_description')}</div>
                </div>
                
                <div class="action-card" data-action="transfer-node">
                    <div class="action-icon">🔄</div>
                    <div class="action-title">${this.i18n.t('node.transfer')}</div>
                    <div class="action-description">${this.i18n.t('node.transfer_description')}</div>
                </div>
            </div>
        `;
    }

    /**
     * Create Phase 2 Solana actions
     */
    async createPhase2SolanaActions() {
        return `
            <div class="action-grid">
                <div class="action-card" data-action="switch-to-qnet">
                    <div class="action-icon">💎</div>
                    <div class="action-title">${this.i18n.t('network.switch_to_qnet')}</div>
                    <div class="action-description">${this.i18n.t('network.qnet_recommended')}</div>
                </div>
            </div>
        `;
    }

    /**
     * Create Phase 2 QNet actions
     */
    async createPhase2QNetActions() {
        const activationCosts = await this.getActivationCosts();
        
        return `
            <div class="action-grid">
                <div class="action-card primary" data-action="activate-light-qnc">
                    <div class="action-icon">⚡</div>
                    <div class="action-title">${this.i18n.t('node.light_node')}</div>
                    <div class="action-description">${this.i18n.t('node.light_description')}</div>
                    <div class="cost-display">${activationCosts.light.toLocaleString()} QNC</div>
                </div>
                
                <div class="action-card primary" data-action="activate-full-qnc">
                    <div class="action-icon">🔥</div>
                    <div class="action-title">${this.i18n.t('node.full_node')}</div>
                    <div class="action-description">${this.i18n.t('node.full_description')}</div>
                    <div class="cost-display">${activationCosts.full.toLocaleString()} QNC</div>
                </div>
                
                <div class="action-card primary" data-action="activate-super-qnc">
                    <div class="action-icon">⚡</div>
                    <div class="action-title">${this.i18n.t('node.super_node')}</div>
                    <div class="action-description">${this.i18n.t('node.super_description')}</div>
                    <div class="cost-display">${activationCosts.super.toLocaleString()} QNC</div>
                </div>
            </div>
        `;
    }

    /**
     * Bind action event listeners
     */
    bindActionEvents() {
        const actionCards = document.querySelectorAll('.action-card');
        actionCards.forEach(card => {
            card.addEventListener('click', (e) => {
                const action = e.currentTarget.dataset.action;
                if (!card.classList.contains('disabled')) {
                    this.handleAction(action);
                }
            });
        });
    }

    /**
     * Handle action clicks
     */
    handleAction(action) {
        // Emit action event for parent components to handle
        const event = new CustomEvent('phaseAction', {
            detail: { action, mode: this.interfaceMode }
        });
        document.dispatchEvent(event);
    }

    /**
     * Get burn progress information
     */
    async getBurnProgress() {
        try {
            // This would fetch real data from the network
            return {
                percentage: 25,
                currentCost: 1125,
                savings: 375,
                baseCost: 1500
            };
        } catch (error) {
            return {
                percentage: 0,
                currentCost: 1500,
                savings: 0,
                baseCost: 1500
            };
        }
    }

    /**
     * Get activation costs
     */
    async getActivationCosts() {
        try {
            // This would fetch real data from QNet
            return {
                light: 5000,
                full: 7500,
                super: 10000
            };
        } catch (error) {
            return {
                light: 5000,
                full: 7500,
                super: 10000
            };
        }
    }

    /**
     * Handle network events
     */
    handleNetworkEvent(event, data) {
        switch (event) {
            case 'networkChanged':
                this.currentNetwork = data.network;
                this.updateInterface();
                break;
                
            case 'initialized':
                this.currentPhase = data.phase;
                this.updateInterface();
                break;
        }
    }

    /**
     * Bind events
     */
    bindEvents() {
        // Listen for phase action events
        document.addEventListener('phaseAction', (e) => {
            console.log('Phase action triggered:', e.detail);
        });
    }

    /**
     * Set interface mode manually
     */
    setInterfaceMode(phase, network) {
        this.currentPhase = phase;
        this.currentNetwork = network;
        this.updateInterface();
    }

    /**
     * Get current interface mode
     */
    getInterfaceMode() {
        return this.interfaceMode;
    }

    /**
     * Destroy interface
     */
    destroy() {
        const container = document.getElementById('phase-interface');
        if (container) {
            container.innerHTML = '';
        }
    }
} 