/**
 * Phase-Aware UI Component
 * Adapts wallet interface based on QNet phase and network
 * Provides guided activation flows for Phase 1 (1DEV burn) and Phase 2 (QNC spend)
 */

import { dualNetworkManager } from '../network/DualNetworkManager.js';

export class PhaseAwareUI {
    constructor() {
        this.currentPhase = 1;
        this.currentNetwork = 'solana';
        this.activationInProgress = false;
    }

    /**
     * Initialize phase-aware UI system
     */
    async initialize() {
        try {
            // Listen for network changes
            window.addEventListener('networkChanged', (event) => {
                this.handleNetworkChange(event.detail);
            });

            // Initialize UI
            await this.updateUI();
            this.setupNetworkSwitcher();
            
            return true;
        } catch (error) {
            console.error('Failed to initialize phase-aware UI:', error);
            throw error;
        }
    }

    /**
     * Update UI based on current phase and network
     */
    async updateUI() {
        try {
            this.currentPhase = dualNetworkManager.getCurrentPhase();
            this.currentNetwork = dualNetworkManager.getCurrentNetwork();

            // Update network switcher
            this.updateNetworkSwitcher();
            
            // Show appropriate interface
            if (this.currentPhase === 1 && this.currentNetwork === 'solana') {
                this.showPhase1SolanaInterface();
            } else if (this.currentPhase === 1 && this.currentNetwork === 'qnet') {
                this.showPhase1QNetInterface();
            } else if (this.currentPhase === 2 && this.currentNetwork === 'qnet') {
                this.showPhase2QNetInterface();
            } else if (this.currentPhase === 2 && this.currentNetwork === 'solana') {
                this.showPhase2MigrationNotice();
            }

        } catch (error) {
            console.error('Failed to update UI:', error);
        }
    }

    /**
     * Setup network switcher in header
     */
    setupNetworkSwitcher() {
        const header = document.querySelector('.wallet-header') || this.createWalletHeader();
        
        if (!header.querySelector('.network-switcher')) {
            const switcher = document.createElement('div');
            switcher.className = 'network-switcher';
            switcher.innerHTML = `
                <button class="network-btn" data-network="solana" onclick="phaseAwareUI.switchNetwork('solana')">
                    🔥 Solana
                </button>
                <button class="network-btn" data-network="qnet" onclick="phaseAwareUI.switchNetwork('qnet')">
                    💎 QNet
                </button>
                <div class="phase-indicator" id="phase-indicator">
                    Phase ${this.currentPhase}
                </div>
            `;
            
            header.appendChild(switcher);
        }
    }

    /**
     * Create wallet header if it doesn't exist
     */
    createWalletHeader() {
        let header = document.querySelector('.wallet-header');
        if (!header) {
            header = document.createElement('div');
            header.className = 'wallet-header';
            document.body.insertBefore(header, document.body.firstChild);
        }
        return header;
    }

    /**
     * Show Phase 1 Solana interface (1DEV burn activation)
     */
    showPhase1SolanaInterface() {
        const container = this.getMainContainer();
        container.innerHTML = `
            <div class="phase1-solana">
                <div class="network-status">
                    <h2>🔥 Solana Network - Node Activation</h2>
                    <div class="phase-badge">Phase 1 Active</div>
                </div>

                <div class="wallet-info">
                    <div class="address-section">
                        <label>Address:</label>
                        <span id="current-address">Loading...</span>
                        <button onclick="phaseAwareUI.copyAddress()">📋</button>
                    </div>
                    
                    <div class="balances">
                        <div class="balance-item">
                            <span>SOL:</span>
                            <span id="sol-balance">0.00</span>
                        </div>
                        <div class="balance-item">
                            <span>1DEV:</span>
                            <span id="onedev-balance">0</span>
                        </div>
                    </div>
                </div>

                <div class="burn-progress-section">
                    <h3>📊 Phase 1 Progress</h3>
                    <div class="progress-bar">
                        <div class="progress-fill" id="burn-progress"></div>
                    </div>
                    <p>Current Price: <span id="current-price">1,350 1DEV</span></p>
                    <p class="savings">Your Savings: <span id="savings">150 1DEV (10%)</span></p>
                </div>

                <div class="activation-options">
                    <h3>🤖 Cross-Chain Activation</h3>
                    <div class="node-types">
                        <div class="node-card" data-type="light">
                            <div class="node-icon">⚡</div>
                            <h4>Light Node</h4>
                            <div class="cost" id="light-cost">1,350 1DEV</div>
                            <button onclick="phaseAwareUI.startActivation('light')">
                                Activate Light Node
                            </button>
                        </div>
                        
                        <div class="node-card" data-type="full">
                            <div class="node-icon">🔥</div>
                            <h4>Full Node</h4>
                            <div class="cost" id="full-cost">2,025 1DEV</div>
                            <button onclick="phaseAwareUI.startActivation('full')">
                                Activate Full Node
                            </button>
                        </div>
                        
                        <div class="node-card" data-type="super">
                            <div class="node-icon">⭐</div>
                            <h4>Super Node</h4>
                            <div class="cost" id="super-cost">2,700 1DEV</div>
                            <button onclick="phaseAwareUI.startActivation('super')">
                                Activate Super Node
                            </button>
                        </div>
                    </div>
                </div>

                <div class="bridge-status">
                    <p>🌉 Bridge: <span id="bridge-status">✅ Online</span></p>
                    <p class="note">➡️ Codes appear in QNet network</p>
                </div>
            </div>
        `;

        this.loadSolanaData();
    }

    /**
     * Show Phase 1 QNet interface (Node management)
     */
    showPhase1QNetInterface() {
        const container = this.getMainContainer();
        container.innerHTML = `
            <div class="phase1-qnet">
                <div class="network-status">
                    <h2>💎 QNet Network - Node Management</h2>
                    <div class="phase-badge">Phase 1</div>
                </div>

                <div class="eon-address">
                    <label>EON Address:</label>
                    <span id="eon-address">Loading...</span>
                    <button onclick="phaseAwareUI.copyAddress()">📋</button>
                </div>

                <div class="qnc-balance">
                    <label>QNC Balance:</label>
                    <span id="qnc-balance">0 QNC</span>
                </div>

                <div class="node-status" id="node-status">
                    <!-- Populated dynamically -->
                </div>

                <div class="activation-codes">
                    <h3>📋 Activation Codes</h3>
                    <div id="codes-list">
                        <!-- Populated dynamically -->
                    </div>
                </div>

                <div class="network-info">
                    <h3>📊 Network Info</h3>
                    <p>Phase: 1 → 2 (<span id="transition-progress">75%</span> to transition)</p>
                    <p>Active Nodes: <span id="active-nodes">156,234</span></p>
                </div>
            </div>
        `;

        this.loadQNetData();
    }

    /**
     * Show Phase 2 QNet interface (Native QNC activation)
     */
    showPhase2QNetInterface() {
        const container = this.getMainContainer();
        container.innerHTML = `
            <div class="phase2-qnet">
                <div class="network-status">
                    <h2>💎 QNet Network - Phase 2 Active</h2>
                    <div class="phase-badge phase2">Phase 2</div>
                </div>

                <div class="eon-address">
                    <label>EON Address:</label>
                    <span id="eon-address">Loading...</span>
                    <button onclick="phaseAwareUI.copyAddress()">📋</button>
                </div>

                <div class="qnc-balance-large">
                    <label>QNC Balance:</label>
                    <span id="qnc-balance">0 QNC</span>
                </div>

                <div class="phase2-info">
                    <h3>📊 Phase 2: QNC to Pool 3</h3>
                    <p>Network: <span id="total-nodes">1,234,567</span> active nodes</p>
                    <p>Multiplier: <span id="multiplier">2.0x (High demand)</span></p>
                </div>

                <div class="native-activation">
                    <h3>🤖 Native QNC Activation</h3>
                    <div class="node-types">
                        <div class="node-card" data-type="light">
                            <div class="node-icon">⚡</div>
                            <h4>Light Node</h4>
                            <div class="cost" id="light-qnc-cost">10,000 QNC</div>
                            <button onclick="phaseAwareUI.startPhase2Activation('light')">
                                Send to Pool 3
                            </button>
                        </div>
                        
                        <div class="node-card" data-type="full">
                            <div class="node-icon">🔥</div>
                            <h4>Full Node</h4>
                            <div class="cost" id="full-qnc-cost">15,000 QNC</div>
                            <button onclick="phaseAwareUI.startPhase2Activation('full')">
                                Send to Pool 3
                            </button>
                        </div>
                        
                        <div class="node-card" data-type="super">
                            <div class="node-icon">⭐</div>
                            <h4>Super Node</h4>
                            <div class="cost" id="super-qnc-cost">20,000 QNC</div>
                            <button onclick="phaseAwareUI.startPhase2Activation('super')">
                                Send to Pool 3
                            </button>
                        </div>
                    </div>
                </div>

                <div class="pool3-bonus">
                    <p>🎁 Pool 3 Bonus: All spent QNC redistributed to all active nodes!</p>
                </div>
            </div>
        `;

        this.loadPhase2Data();
    }

    /**
     * Show Phase 2 migration notice on Solana
     */
    showPhase2MigrationNotice() {
        const container = this.getMainContainer();
        container.innerHTML = `
            <div class="phase2-migration">
                <div class="migration-notice">
                    <h2>🚀 QNet Phase 2 Active!</h2>
                    <p>Node activation has moved to native QNet network.</p>
                    <p>Switch to QNet network for Phase 2 activation with QNC tokens.</p>
                    
                    <button class="switch-btn" onclick="phaseAwareUI.switchNetwork('qnet')">
                        Switch to QNet Network →
                    </button>
                </div>
                
                <div class="phase2-benefits">
                    <h3>Phase 2 Benefits:</h3>
                    <ul>
                        <li>✅ Native QNC activation</li>
                        <li>✅ Direct to Pool 3 distribution</li>
                        <li>✅ Instant node activation</li>
                        <li>✅ Higher rewards</li>
                    </ul>
                </div>
            </div>
        `;
    }

    /**
     * Switch between networks
     */
    async switchNetwork(network) {
        try {
            if (network === 'solana') {
                await dualNetworkManager.switchToSolana();
            } else if (network === 'qnet') {
                await dualNetworkManager.switchToQNet();
            }
        } catch (error) {
            console.error(`Failed to switch to ${network}:`, error);
            this.showError(`Failed to switch to ${network} network`);
        }
    }

    /**
     * Start Phase 1 activation process
     */
    async startActivation(nodeType) {
        if (this.activationInProgress) return;
        
        try {
            this.activationInProgress = true;
            this.showGuidedFlow(nodeType);
            
            // Execute Phase 1 flow
            await this.executePhase1Flow(nodeType);
            
        } catch (error) {
            console.error('Activation failed:', error);
            this.showError(`Activation failed: ${error.message}`);
        } finally {
            this.activationInProgress = false;
            this.hideGuidedFlow();
        }
    }

    /**
     * Start Phase 2 activation
     */
    async startPhase2Activation(nodeType) {
        if (this.activationInProgress) return;
        
        try {
            this.activationInProgress = true;
            
            // Execute Phase 2 flow
            await this.executePhase2Flow(nodeType);
            
        } catch (error) {
            console.error('Phase 2 activation failed:', error);
            this.showError(`Phase 2 activation failed: ${error.message}`);
        } finally {
            this.activationInProgress = false;
        }
    }

    /**
     * Execute Phase 1 guided flow
     */
    async executePhase1Flow(nodeType) {
        const steps = [
            'Ensure Solana network connection',
            'Burn 1DEV tokens for activation',
            'Wait for bridge verification',
            'Switch to QNet network',
            'Activate node with received code'
        ];

        for (let i = 0; i < steps.length; i++) {
            this.updateFlowStep(i, steps[i]);
            
            // Execute step
            switch (i) {
                case 0:
                    await this.ensureSolanaConnection();
                    break;
                case 1:
                    await this.burnOneDevTokens(nodeType);
                    break;
                case 2:
                    await this.waitForBridgeVerification();
                    break;
                case 3:
                    await this.switchNetwork('qnet');
                    break;
                case 4:
                    await this.activateNodeWithCode();
                    break;
            }
            
            this.completeFlowStep(i);
        }
    }

    /**
     * Execute Phase 2 flow
     */
    async executePhase2Flow(nodeType) {
        // Direct QNC send to Pool 3 - simplified flow
        console.log(`Executing Phase 2 activation for ${nodeType} node`);
        
        // Implementation would integrate with QNet RPC
        // to send QNC to Pool 3 and activate node
    }

    /**
     * Update network switcher active state
     */
    updateNetworkSwitcher() {
        document.querySelectorAll('.network-btn').forEach(btn => {
            btn.classList.remove('active');
            if (btn.dataset.network === this.currentNetwork) {
                btn.classList.add('active');
            }
        });
        
        const phaseIndicator = document.getElementById('phase-indicator');
        if (phaseIndicator) {
            phaseIndicator.textContent = `Phase ${this.currentPhase}`;
        }
    }

    /**
     * Handle network change events
     */
    handleNetworkChange(detail) {
        this.currentNetwork = detail.network;
        this.currentPhase = detail.phase;
        this.updateUI();
    }

    /**
     * Get main container element
     */
    getMainContainer() {
        let container = document.getElementById('main-content');
        if (!container) {
            container = document.createElement('div');
            container.id = 'main-content';
            document.body.appendChild(container);
        }
        return container;
    }

    /**
     * Load Solana network data
     */
    async loadSolanaData() {
        try {
            const data = await dualNetworkManager.switchToSolana();
            
            // Update UI with loaded data
            this.updateElement('current-address', data.address || 'Not connected');
            this.updateElement('sol-balance', `${data.balances?.SOL?.toFixed(3) || '0.00'} SOL`);
            this.updateElement('onedev-balance', `${data.balances?.['1DEV'] || 0} 1DEV`);
            
        } catch (error) {
            console.error('Failed to load Solana data:', error);
        }
    }

    /**
     * Load QNet network data
     */
    async loadQNetData() {
        try {
            const data = await dualNetworkManager.switchToQNet();
            
            // Update UI with loaded data
            this.updateElement('eon-address', data.address || 'Loading...');
            this.updateElement('qnc-balance', `${data.balances?.QNC || 0} QNC`);
            
            // Update node status
            this.updateNodeStatus(data.nodeInfo);
            
        } catch (error) {
            console.error('Failed to load QNet data:', error);
        }
    }

    /**
     * Load Phase 2 specific data
     */
    async loadPhase2Data() {
        await this.loadQNetData();
        // Load additional Phase 2 specific data
    }

    /**
     * Update node status section
     */
    updateNodeStatus(nodeInfo) {
        const container = document.getElementById('node-status');
        if (!container) return;

        if (nodeInfo) {
            container.innerHTML = `
                <div class="active-node">
                    <h3>🤖 Your Active Node</h3>
                    <p>Code: <strong>${nodeInfo.code}</strong></p>
                    <p>Type: <strong>${nodeInfo.type} Node</strong></p>
                    <p>Status: <strong class="status-${nodeInfo.status}">${nodeInfo.status}</strong></p>
                    <p>Uptime: <strong>${nodeInfo.uptime}%</strong></p>
                    <p>Rewards: <strong>+${nodeInfo.rewards} QNC/day</strong></p>
                    
                    <div class="node-actions">
                        <button onclick="phaseAwareUI.monitorNode()">📊 Monitor</button>
                        <button onclick="phaseAwareUI.migrateDevice()">🔄 Migrate</button>
                    </div>
                </div>
            `;
        } else {
            container.innerHTML = `
                <div class="no-node">
                    <p>No active node found.</p>
                    <p>Activate a node to start earning rewards.</p>
                </div>
            `;
        }
    }

    /**
     * Show guided flow overlay
     */
    showGuidedFlow(nodeType) {
        const overlay = document.createElement('div');
        overlay.className = 'guided-flow-overlay';
        overlay.id = 'guided-flow';
        overlay.innerHTML = `
            <div class="flow-modal">
                <div class="flow-header">
                    <h3>Activating ${nodeType} Node</h3>
                    <button onclick="phaseAwareUI.hideGuidedFlow()">×</button>
                </div>
                <div class="flow-steps" id="flow-steps">
                    <!-- Steps populated dynamically -->
                </div>
            </div>
        `;
        
        document.body.appendChild(overlay);
    }

    /**
     * Hide guided flow overlay
     */
    hideGuidedFlow() {
        const overlay = document.getElementById('guided-flow');
        if (overlay) {
            overlay.remove();
        }
    }

    /**
     * Copy address to clipboard
     */
    async copyAddress() {
        try {
            let address = '';
            if (this.currentNetwork === 'solana') {
                address = document.getElementById('current-address')?.textContent || '';
            } else {
                address = document.getElementById('eon-address')?.textContent || '';
            }
            
            await navigator.clipboard.writeText(address);
            this.showToast('Address copied to clipboard');
        } catch (error) {
            console.error('Failed to copy address:', error);
        }
    }

    /**
     * Update element text content
     */
    updateElement(id, text) {
        const element = document.getElementById(id);
        if (element) {
            element.textContent = text;
        }
    }

    /**
     * Show error message
     */
    showError(message) {
        console.error(message);
        // Implementation for error display
    }

    /**
     * Show toast notification
     */
    showToast(message) {
        console.log(message);
        // Implementation for toast notification
    }

    // Placeholder methods for button handlers
    async ensureSolanaConnection() { /* Implementation */ }
    async burnOneDevTokens(nodeType) { /* Implementation */ }
    async waitForBridgeVerification() { /* Implementation */ }
    async activateNodeWithCode() { /* Implementation */ }
    updateFlowStep(index, text) { /* Implementation */ }
    completeFlowStep(index) { /* Implementation */ }
    monitorNode() { /* Implementation */ }
    migrateDevice() { /* Implementation */ }
}

// Export and make globally available
const phaseAwareUI = new PhaseAwareUI();
window.phaseAwareUI = phaseAwareUI;

export default PhaseAwareUI;
