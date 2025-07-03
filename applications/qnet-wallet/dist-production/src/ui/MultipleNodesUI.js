// QNet Multiple Nodes Management UI
export class MultipleNodesUI {
    constructor(walletManager) {
        this.walletManager = walletManager;
        this.container = null;
    }

    // Render main interface
    render(container) {
        this.container = container;
        
        const html = `
            <div class="multiple-nodes-container">
                <div class="header">
                    <h2>🏦 Multiple Nodes Management</h2>
                    <p>Create additional accounts to activate multiple nodes</p>
                </div>
                
                <div class="accounts-section">
                    <div class="section-header">
                        <h3>📱 Your Accounts</h3>
                        <button id="add-account-btn" class="btn-primary">
                            ➕ Add New Account
                        </button>
                    </div>
                    <div id="accounts-list" class="accounts-list">
                        <!-- Accounts will be loaded here -->
                    </div>
                </div>
                
                <div class="nodes-section">
                    <div class="section-header">
                        <h3>⚡ Active Nodes</h3>
                    </div>
                    <div id="nodes-list" class="nodes-list">
                        <!-- Active nodes will be loaded here -->
                    </div>
                </div>
                
                <div class="activation-section">
                    <div class="section-header">
                        <h3>🚀 Node Activation</h3>
                    </div>
                    <div id="activation-form" class="activation-form">
                        <!-- Activation form will be loaded here -->
                    </div>
                </div>
            </div>
        `;
        
        container.innerHTML = html;
        this.bindEvents();
        this.loadAccounts();
        this.loadActiveNodes();
        this.renderActivationForm();
    }

    // Bind event handlers
    bindEvents() {
        const addAccountBtn = document.getElementById('add-account-btn');
        addAccountBtn.addEventListener('click', () => this.showAddAccountDialog());
    }

    // Load and display accounts
    async loadAccounts() {
        try {
            const accounts = this.walletManager.getAccounts();
            const accountsList = document.getElementById('accounts-list');
            
            if (accounts.length === 0) {
                accountsList.innerHTML = '<p class="no-data">No accounts found</p>';
                return;
            }
            
            const accountsHtml = accounts.map(account => `
                <div class="account-card ${account.hasActiveNode ? 'has-node' : 'can-activate'}">
                    <div class="account-info">
                        <h4>${account.name}</h4>
                        <p class="address">${account.address.substring(0, 20)}...</p>
                        <div class="status">
                            ${account.hasActiveNode ? 
                                `<span class="status-active">🟢 ${account.nodeType} Node Active</span>` :
                                `<span class="status-available">🔵 Available for Node</span>`
                            }
                        </div>
                    </div>
                    <div class="account-actions">
                        ${!account.hasActiveNode && account.canActivateNode ? 
                            `<button class="btn-activate" onclick="multipleNodesUI.activateNodeForAccount(${account.index})">
                                🚀 Activate Node
                            </button>` : ''
                        }
                        ${account.hasActiveNode ? 
                            `<button class="btn-view" onclick="multipleNodesUI.viewNodeDetails(${account.index})">
                                📊 View Details
                            </button>` : ''
                        }
                    </div>
                </div>
            `).join('');
            
            accountsList.innerHTML = accountsHtml;
        } catch (error) {
            console.error('Error loading accounts:', error);
            document.getElementById('accounts-list').innerHTML = 
                '<p class="error">Error loading accounts</p>';
        }
    }

    // Load and display active nodes
    async loadActiveNodes() {
        try {
            const nodesWithAccounts = this.walletManager.getAccountsWithNodes();
            const nodesList = document.getElementById('nodes-list');
            
            if (nodesWithAccounts.length === 0) {
                nodesList.innerHTML = '<p class="no-data">No active nodes</p>';
                return;
            }
            
            const nodesHtml = nodesWithAccounts.map(account => `
                <div class="node-card node-${account.nodeType}">
                    <div class="node-header">
                        <h4>${account.nodeType.toUpperCase()} Node</h4>
                        <span class="node-status">🟢 Active</span>
                    </div>
                    <div class="node-details">
                        <p><strong>Account:</strong> ${account.name}</p>
                        <p><strong>Address:</strong> ${account.address.substring(0, 20)}...</p>
                        <p><strong>Activated:</strong> ${new Date(account.activatedAt).toLocaleDateString()}</p>
                    </div>
                    <div class="node-actions">
                        <button class="btn-rewards" onclick="multipleNodesUI.viewRewards(${account.index})">
                            💰 View Rewards
                        </button>
                        <button class="btn-settings" onclick="multipleNodesUI.nodeSettings(${account.index})">
                            ⚙️ Settings
                        </button>
                    </div>
                </div>
            `).join('');
            
            nodesList.innerHTML = nodesHtml;
        } catch (error) {
            console.error('Error loading nodes:', error);
            document.getElementById('nodes-list').innerHTML = 
                '<p class="error">Error loading nodes</p>';
        }
    }

    // Render activation form
    renderActivationForm() {
        try {
            const availableAccounts = this.walletManager.getAccountsForNodeActivation();
            const activationForm = document.getElementById('activation-form');
            
            if (availableAccounts.length === 0) {
                activationForm.innerHTML = `
                    <div class="no-accounts-message">
                        <p>All accounts have active nodes or no accounts available.</p>
                        <button class="btn-primary" onclick="multipleNodesUI.showAddAccountDialog()">
                            ➕ Create New Account for Node
                        </button>
                    </div>
                `;
                return;
            }
            
            const formHtml = `
                <div class="activation-form-content">
                    <div class="form-group">
                        <label for="account-select">Select Account:</label>
                        <select id="account-select" class="form-control">
                            ${availableAccounts.map(account => 
                                `<option value="${account.index}">${account.name} (${account.address.substring(0, 20)}...)</option>`
                            ).join('')}
                        </select>
                    </div>
                    
                    <div class="form-group">
                        <label for="node-type-select">Node Type:</label>
                        <select id="node-type-select" class="form-control">
                            <option value="light">Light Node (2.5k-15k QNC)</option>
                            <option value="full">Full Node (3.75k-22.5k QNC)</option>
                            <option value="super">Super Node (5k-30k QNC)</option>
                        </select>
                    </div>
                    
                    <div class="form-actions">
                        <button id="activate-node-btn" class="btn-primary btn-large">
                            🚀 Activate Node
                        </button>
                    </div>
                </div>
            `;
            
            activationForm.innerHTML = formHtml;
            
            // Bind activation button
            document.getElementById('activate-node-btn').addEventListener('click', () => {
                this.handleNodeActivation();
            });
            
        } catch (error) {
            console.error('Error rendering activation form:', error);
            document.getElementById('activation-form').innerHTML = 
                '<p class="error">Error loading activation form</p>';
        }
    }

    // Show add account dialog
    async showAddAccountDialog() {
        const name = prompt('Enter account name:');
        if (!name) return;
        
        try {
            const newAccount = await this.walletManager.addAccountForNode(name);
            
            alert(`✅ Account "${newAccount.name}" created successfully!\nAddress: ${newAccount.address}\nReady for node activation.`);
            
            // Refresh UI
            this.loadAccounts();
            this.renderActivationForm();
            
        } catch (error) {
            alert(`❌ Error creating account: ${error.message}`);
        }
    }

    // Handle node activation
    async handleNodeActivation() {
        const accountIndex = parseInt(document.getElementById('account-select').value);
        const nodeType = document.getElementById('node-type-select').value;
        
        if (isNaN(accountIndex)) {
            alert('Please select an account');
            return;
        }
        
        try {
            const result = await this.walletManager.activateNode(nodeType, accountIndex);
            
            alert(`✅ Node activated successfully!\nType: ${result.nodeType}\nAccount: ${result.accountName}\nAddress: ${result.accountAddress}`);
            
            // Refresh UI
            this.loadAccounts();
            this.loadActiveNodes();
            this.renderActivationForm();
            
        } catch (error) {
            alert(`❌ Node activation failed: ${error.message}`);
        }
    }

    // Activate node for specific account
    async activateNodeForAccount(accountIndex) {
        const nodeType = prompt('Select node type (light/full/super):', 'light');
        if (!nodeType || !['light', 'full', 'super'].includes(nodeType)) {
            alert('Invalid node type');
            return;
        }
        
        try {
            const result = await this.walletManager.activateNode(nodeType, accountIndex);
            
            alert(`✅ Node activated successfully!\nType: ${result.nodeType}\nAccount: ${result.accountName}`);
            
            // Refresh UI
            this.loadAccounts();
            this.loadActiveNodes();
            this.renderActivationForm();
            
        } catch (error) {
            alert(`❌ Node activation failed: ${error.message}`);
        }
    }

    // View node details
    viewNodeDetails(accountIndex) {
        const accounts = this.walletManager.getAccounts();
        const account = accounts[accountIndex];
        
        if (!account || !account.nodeConfig) {
            alert('Node not found');
            return;
        }
        
        const details = `
Node Details:
- Type: ${account.nodeType}
- Account: ${account.name}
- Address: ${account.address}
- Activated: ${new Date(account.nodeConfig.activatedAt).toLocaleString()}
- Status: Active
        `;
        
        alert(details);
    }

    // View rewards
    viewRewards(accountIndex) {
        alert('Rewards viewing feature coming soon!');
    }

    // Node settings
    nodeSettings(accountIndex) {
        alert('Node settings feature coming soon!');
    }
}

// Global instance
window.multipleNodesUI = null;

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    // Will be initialized by main wallet app
}); 