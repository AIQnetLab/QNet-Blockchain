/**
 * Token List Component for QNet Wallet
 * Displays all tokens for current network with balances and custom token support
 */

import { getAllTokens, addCustomToken } from '../config/FeeConfig.js';

export class TokenList {
    constructor(container, network = 'solana') {
        this.container = container;
        this.network = network;
        this.tokens = {};
        this.balances = {};
        
        this.init();
    }

    init() {
        this.loadTokens();
        this.render();
        this.bindEvents();
    }

    loadTokens() {
        this.tokens = getAllTokens(this.network);
        console.log(`✅ Loaded ${Object.keys(this.tokens).length} tokens for ${this.network}`);
    }

    async loadBalances() {
        // Load balances for all tokens
        for (const [symbol, token] of Object.entries(this.tokens)) {
            try {
                // For now, use mock balances - will be replaced with real blockchain calls
                this.balances[symbol] = Math.random() * 1000;
            } catch (error) {
                console.error(`Failed to load balance for ${symbol}:`, error);
                this.balances[symbol] = 0;
            }
        }
    }

    render() {
        if (!this.container) return;

        this.container.innerHTML = `
            <div class="token-list">
                <div class="token-list-header">
                    <h3>Assets (${this.network.toUpperCase()})</h3>
                    <button class="add-token-btn" id="add-token-btn">
                        ➕ Add Token
                    </button>
                </div>
                
                <div class="token-search">
                    <input type="text" 
                           id="token-search" 
                           placeholder="Search tokens..." 
                           class="search-input">
                </div>
                
                <div class="token-items" id="token-items">
                    ${this.renderTokenItems()}
                </div>
                
                <!-- Add Custom Token Modal -->
                <div class="modal hidden" id="add-token-modal">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h3>Add Custom Token</h3>
                            <button class="modal-close" id="close-modal">&times;</button>
                        </div>
                        <div class="modal-body">
                            ${this.renderAddTokenForm()}
                        </div>
                    </div>
                </div>
            </div>
        `;

        this.loadBalances();
    }

    renderTokenItems() {
        return Object.entries(this.tokens).map(([symbol, token]) => {
            const balance = this.balances[symbol] || 0;
            const balanceFormatted = balance.toFixed(4);
            const isCustom = token.isCustom || false;
            
            return `
                <div class="token-item" data-symbol="${symbol}">
                    <div class="token-icon">
                        <img src="${token.logoURI || '/icons/default-token.png'}" 
                             alt="${symbol}" 
                             onerror="this.src='/icons/default-token.png'">
                    </div>
                    <div class="token-info">
                        <div class="token-symbol">
                            ${symbol}
                            ${isCustom ? '<span class="custom-badge">Custom</span>' : ''}
                        </div>
                        <div class="token-name">${token.name}</div>
                    </div>
                    <div class="token-balance">
                        <div class="balance-amount">${balanceFormatted}</div>
                        <div class="balance-usd">~$${(balance * 1.2).toFixed(2)}</div>
                    </div>
                    <div class="token-actions">
                        <button class="action-btn send-btn" data-symbol="${symbol}">Send</button>
                        <button class="action-btn swap-btn" data-symbol="${symbol}">Swap</button>
                        ${isCustom ? `<button class="action-btn remove-btn" data-symbol="${symbol}">Remove</button>` : ''}
                    </div>
                </div>
            `;
        }).join('');
    }

    renderAddTokenForm() {
        const fields = this.network === 'solana' 
            ? `
                <div class="form-group">
                    <label>Token Mint Address *</label>
                    <input type="text" 
                           id="token-mint" 
                           placeholder="Token mint address" 
                           class="form-input">
                </div>
            `
            : `
                <div class="form-group">
                    <label>Token Contract Address *</label>
                    <input type="text" 
                           id="token-address" 
                           placeholder="Token contract address" 
                           class="form-input">
                </div>
            `;

        return `
            <form id="add-token-form">
                <div class="form-group">
                    <label>Token Symbol *</label>
                    <input type="text" 
                           id="token-symbol" 
                           placeholder="e.g., MYTOKEN" 
                           class="form-input" 
                           maxlength="10">
                </div>
                
                <div class="form-group">
                    <label>Token Name *</label>
                    <input type="text" 
                           id="token-name" 
                           placeholder="e.g., My Custom Token" 
                           class="form-input">
                </div>
                
                ${fields}
                
                <div class="form-group">
                    <label>Decimals *</label>
                    <input type="number" 
                           id="token-decimals" 
                           placeholder="18" 
                           class="form-input" 
                           min="0" 
                           max="18" 
                           value="18">
                </div>
                
                <div class="form-group">
                    <label>Logo URL (optional)</label>
                    <input type="url" 
                           id="token-logo" 
                           placeholder="https://example.com/logo.png" 
                           class="form-input">
                </div>
                
                <div class="form-actions">
                    <button type="button" class="btn btn-secondary" id="cancel-add-token">
                        Cancel
                    </button>
                    <button type="submit" class="btn btn-primary">
                        Add Token
                    </button>
                </div>
            </form>
        `;
    }

    bindEvents() {
        // Add token button
        const addTokenBtn = document.getElementById('add-token-btn');
        if (addTokenBtn) {
            addTokenBtn.addEventListener('click', () => this.showAddTokenModal());
        }

        // Close modal
        const closeModal = document.getElementById('close-modal');
        if (closeModal) {
            closeModal.addEventListener('click', () => this.hideAddTokenModal());
        }

        // Cancel add token
        const cancelBtn = document.getElementById('cancel-add-token');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => this.hideAddTokenModal());
        }

        // Add token form
        const addTokenForm = document.getElementById('add-token-form');
        if (addTokenForm) {
            addTokenForm.addEventListener('submit', (e) => this.handleAddToken(e));
        }

        // Token search
        const searchInput = document.getElementById('token-search');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => this.handleSearch(e.target.value));
        }

        // Token actions
        this.container.addEventListener('click', (e) => {
            if (e.target.classList.contains('send-btn')) {
                this.handleSend(e.target.dataset.symbol);
            } else if (e.target.classList.contains('swap-btn')) {
                this.handleSwap(e.target.dataset.symbol);
            } else if (e.target.classList.contains('remove-btn')) {
                this.handleRemoveToken(e.target.dataset.symbol);
            }
        });

        // Close modal when clicking outside
        window.addEventListener('click', (e) => {
            const modal = document.getElementById('add-token-modal');
            if (e.target === modal) {
                this.hideAddTokenModal();
            }
        });
    }

    showAddTokenModal() {
        const modal = document.getElementById('add-token-modal');
        if (modal) {
            modal.style.display = 'flex';
        }
    }

    hideAddTokenModal() {
        const modal = document.getElementById('add-token-modal');
        if (modal) {
            modal.style.display = 'none';
        }
        
        // Reset form
        const form = document.getElementById('add-token-form');
        if (form) form.reset();
    }

    async handleAddToken(e) {
        e.preventDefault();
        
        const symbol = document.getElementById('token-symbol').value.trim().toUpperCase();
        const name = document.getElementById('token-name').value.trim();
        const decimals = parseInt(document.getElementById('token-decimals').value);
        const logoURI = document.getElementById('token-logo').value.trim();
        
        // Network specific fields
        let address;
        if (this.network === 'solana') {
            address = document.getElementById('token-mint').value.trim();
        } else {
            address = document.getElementById('token-address').value.trim();
        }
        
        // Validation
        if (!symbol || !name || !address || isNaN(decimals)) {
            this.showError('Please fill in all required fields');
            return;
        }
        
        if (this.tokens[symbol]) {
            this.showError('Token with this symbol already exists');
            return;
        }
        
        // Create token data
        const tokenData = {
            symbol,
            name,
            decimals,
            logoURI: logoURI || '/icons/default-token.png',
            [this.network === 'solana' ? 'mintAddress' : 'address']: address
        };
        
        try {
            // Add token to configuration
            const success = addCustomToken(this.network, tokenData);
            
            if (success) {
                this.showSuccess(`Token ${symbol} added successfully!`);
                this.loadTokens();
                this.render();
                this.hideAddTokenModal();
            } else {
                this.showError('Failed to add token');
            }
        } catch (error) {
            console.error('Error adding token:', error);
            this.showError('Error adding token: ' + error.message);
        }
    }

    handleSearch(query) {
        const tokenItems = document.querySelectorAll('.token-item');
        const searchTerm = query.toLowerCase();
        
        tokenItems.forEach(item => {
            const symbol = item.dataset.symbol.toLowerCase();
            const tokenInfo = this.tokens[item.dataset.symbol.toUpperCase()];
            const name = tokenInfo ? tokenInfo.name.toLowerCase() : '';
            
            const matches = symbol.includes(searchTerm) || name.includes(searchTerm);
            item.style.display = matches ? 'flex' : 'none';
        });
    }

    handleSend(symbol) {
        // Emit event for parent component to handle
        window.dispatchEvent(new CustomEvent('token-send', { 
            detail: { symbol, network: this.network } 
        }));
    }

    handleSwap(symbol) {
        // Emit event for parent component to handle
        window.dispatchEvent(new CustomEvent('token-swap', { 
            detail: { symbol, network: this.network } 
        }));
    }

    handleRemoveToken(symbol) {
        if (confirm(`Remove custom token ${symbol}?`)) {
            // Remove from localStorage
            const customTokens = JSON.parse(localStorage.getItem('qnet_custom_tokens') || '{}');
            if (customTokens[this.network] && customTokens[this.network][symbol]) {
                delete customTokens[this.network][symbol];
                localStorage.setItem('qnet_custom_tokens', JSON.stringify(customTokens));
                
                this.loadTokens();
                this.render();
                this.showSuccess(`Token ${symbol} removed`);
            }
        }
    }

    showError(message) {
        // Simple error display - can be enhanced with toast notifications
        alert('Error: ' + message);
    }

    showSuccess(message) {
        // Simple success display - can be enhanced with toast notifications
        alert('Success: ' + message);
    }

    // Public methods
    updateNetwork(network) {
        this.network = network;
        this.loadTokens();
        this.render();
    }

    refreshBalances() {
        this.loadBalances();
        const tokenItems = document.getElementById('token-items');
        if (tokenItems) {
            tokenItems.innerHTML = this.renderTokenItems();
        }
    }
}

// Export for use in other components
window.TokenList = TokenList; 