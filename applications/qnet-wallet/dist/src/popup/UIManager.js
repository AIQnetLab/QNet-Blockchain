/**
 * QNet Wallet UI Manager - Production Version
 * Handles all UI interactions and display logic
 */

export class UIManager {
    constructor(walletManager) {
        this.walletManager = walletManager;
        this.currentToast = null;
    }

    /**
     * Show locked screen
     */
    showLockedScreen() {
        this.hideElement('main-wallet-screen');
        this.hideModal('wallet-setup-modal');
        this.showElement('locked-screen');
        this.focusElement('password-input');
    }

    /**
     * Show setup screen
     */
    showSetupScreen() {
        this.hideElement('main-wallet-screen');
        this.showElement('locked-screen');
    }

    /**
     * Show main wallet screen
     */
    showMainScreen() {
        this.hideElement('locked-screen');
        this.hideModal('wallet-setup-modal');
        this.showElement('main-wallet-screen');
    }

    /**
     * Update wallet display with current data
     */
    async updateWalletDisplay() {
        if (!this.walletManager.isUnlocked || !this.walletManager.currentWallet) return;

        const currentAccount = this.walletManager.getCurrentAccount();
        if (!currentAccount) return;

        try {
            // Update account info
            this.setText('active-account-name', currentAccount.name);
            this.setText('account-address', this.shortenAddress(currentAccount.address));

            // Get balances
            const [oneDEVBalance, solBalance] = await Promise.all([
                this.walletManager.getTokenBalance(currentAccount.address, '9GcdXAo2EyjNdNLuQoScSVbfJSnh9RdkSS8YYKnGQ8Pf'),
                this.walletManager.getSolBalance(currentAccount.address)
            ]);

            // Update balance displays
            this.setText('1dev-balance-display', `${oneDEVBalance.toFixed(2)} 1DEV`);
            this.setText('total-balance', `${solBalance.toFixed(4)} SOL`);

            // Update token list
            this.updateTokenList(oneDEVBalance, solBalance);

            // Update node activation button
            await this.updateNodeActivationButton(oneDEVBalance);

        } catch (error) {
            this.showToast('Failed to update wallet display', 'error');
        }
    }

    /**
     * Update token list display
     */
    updateTokenList(oneDEVBalance, solBalance) {
        const tokenList = this.getElement('token-list');
        if (!tokenList) return;

        tokenList.innerHTML = '';

        // Add SOL token
        const solItem = this.createTokenItem('SOL', 'Solana', solBalance.toFixed(4), '$0.00');
        tokenList.appendChild(solItem);

        // Add 1DEV token
        const oneDevItem = this.createTokenItem('1DEV', 'QNet Dev Token', oneDEVBalance.toFixed(2), '$0.00');
        tokenList.appendChild(oneDevItem);
    }

    /**
     * Update node activation button state
     */
    async updateNodeActivationButton(oneDEVBalance) {
        const activateButton = this.getElement('activate-node-button');
        if (!activateButton) return;

        try {
            // Import DynamicPricing dynamically to avoid circular dependency
            const { DynamicPricing } = await import('./DynamicPricing.js');
            const dynamicPricing = new DynamicPricing();
            
            // Get current phase and pricing info
            const phaseInfo = dynamicPricing.getCurrentPhase();
            const pricingInfo = dynamicPricing.getPricingInfo();
            
            if (phaseInfo.phase === 'phase1') {
                // Phase 1: 1DEV burn-to-join
                const activationCost = dynamicPricing.getActivationCost('light');
                const hasEnoughTokens = oneDEVBalance >= activationCost.cost;
                
                activateButton.disabled = !hasEnoughTokens;
                activateButton.textContent = hasEnoughTokens ? 
                    `Activate Node (${activationCost.cost} 1DEV)` : 
                    `Need ${activationCost.cost} 1DEV`;

                // Show savings if any
                if (activationCost.cost < 1500) {
                    const savings = 1500 - activationCost.cost;
                    const savingsPercent = ((savings / 1500) * 100).toFixed(1);
                    activateButton.title = `Save ${savings} 1DEV (${savingsPercent}% discount) - ${phaseInfo.burnedPercent}% supply burned`;
                } else {
                    activateButton.title = `Burn ${activationCost.cost} 1DEV tokens permanently`;
                }
            } else {
                // Phase 2: QNC spend-to-Pool3
                const lightCost = dynamicPricing.getActivationCost('light');
                const fullCost = dynamicPricing.getActivationCost('full');
                const superCost = dynamicPricing.getActivationCost('super');
                
                activateButton.textContent = `Phase 2: QNC Spending`;
                activateButton.disabled = true; // Disable for now in Phase 2
                activateButton.title = `Phase 2 Active - Light: ${lightCost.cost} QNC, Full: ${fullCost.cost} QNC, Super: ${superCost.cost} QNC (spend to Pool 3)`;
            }

        } catch (error) {
            // Fallback display
            activateButton.textContent = 'Activate Node (1500 1DEV)';
            activateButton.title = 'Phase 1: Burn 1DEV tokens to activate node';
        }
    }

    /**
     * Create token list item element
     */
    createTokenItem(symbol, name, amount, price) {
        const li = document.createElement('li');
        li.className = 'token-item';
        li.innerHTML = `
            <div class="token-info">
                <div class="token-symbol">${symbol}</div>
                <div class="token-name">${name}</div>
            </div>
            <div class="token-balance">
                <div class="token-amount">${amount}</div>
                <div class="token-price">${price}</div>
            </div>
        `;
        return li;
    }

    /**
     * Show modal dialog
     */
    showModal(modalId) {
        this.showElement(modalId);
    }

    /**
     * Hide modal dialog
     */
    hideModal(modalId) {
        this.hideElement(modalId);
    }

    /**
     * Show create wallet form
     */
    showCreateWalletForm() {
        this.setText('setup-modal-title', 'Create New Wallet');
        this.showElement('create-wallet-content');
        this.hideElement('import-wallet-content');
        this.hideElement('seed-phrase-display');
        this.clearError('password-create-error');
    }

    /**
     * Show import wallet form
     */
    showImportWalletForm() {
        this.setText('setup-modal-title', 'Import Wallet');
        this.hideElement('create-wallet-content');
        this.showElement('import-wallet-content');
        this.hideElement('seed-phrase-display');
        this.clearError('import-error');
    }

    /**
     * Display seed phrase for backup with copy functionality
     */
    displaySeedPhrase(mnemonic) {
        if (!mnemonic) return;
        
        // Store mnemonic for verification later
        this.currentMnemonic = mnemonic;
        
        const words = mnemonic.split(' ');
        const seedPhraseGrid = this.getElement('seed-phrase-words');
        
        if (!seedPhraseGrid) return;

        seedPhraseGrid.innerHTML = '';
        
        words.forEach((word, index) => {
            const wordElement = document.createElement('div');
            wordElement.className = 'seed-word';
            wordElement.innerHTML = `
                <span class="word-number">${index + 1}</span>
                <span class="word-text">${word}</span>
            `;
            seedPhraseGrid.appendChild(wordElement);
        });
        
        this.hideElement('create-wallet-content');
        this.showElement('seed-phrase-display');
        
        // Setup copy functionality
        this.setupSeedPhraseActions(mnemonic);
    }
    
    /**
     * Setup seed phrase action buttons
     */
    setupSeedPhraseActions(mnemonic) {
        const copyButton = this.getElement('copy-seed-button');
        const downloadButton = this.getElement('download-seed-button');
        
        if (copyButton) {
            copyButton.onclick = async () => {
                try {
                    await navigator.clipboard.writeText(mnemonic);
                    this.showToast('Seed phrase copied to clipboard', 'success');
                } catch (error) {
                    this.showToast('Failed to copy seed phrase', 'error');
                }
            };
        }
        
        if (downloadButton) {
            downloadButton.onclick = () => {
                const blob = new Blob([mnemonic], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'qnet-wallet-seed-phrase.txt';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                this.showToast('Seed phrase downloaded', 'success');
            };
        }
    }
    
    /**
     * Show seed phrase verification step
     */
    showSeedVerification() {
        if (!this.currentMnemonic) return;
        
        const words = this.currentMnemonic.split(' ');
        const verificationFields = this.getElement('verification-fields');
        
        if (!verificationFields) return;
        
        // Select 4 random positions for verification
        const positions = this.getRandomPositions(words.length, 4);
        this.verificationPositions = positions;
        this.verificationWords = positions.map(pos => words[pos]);
        
        verificationFields.innerHTML = '';
        
        positions.forEach((position, index) => {
            const fieldDiv = document.createElement('div');
            fieldDiv.className = 'verification-field';
            fieldDiv.innerHTML = `
                <label>Word #${position + 1}</label>
                <input type="text" id="verify-word-${index}" placeholder="Enter word ${position + 1}" autocomplete="off" />
            `;
            verificationFields.appendChild(fieldDiv);
        });
        
        this.hideElement('seed-phrase-display');
        this.showElement('seed-verification');
    }
    
    /**
     * Verify seed phrase words
     */
    verifySeedPhrase() {
        const userWords = [];
        
        for (let i = 0; i < this.verificationPositions.length; i++) {
            const input = this.getElement(`verify-word-${i}`);
            if (input) {
                userWords.push(input.value.trim().toLowerCase());
            }
        }
        
        const correctWords = this.verificationWords.map(word => word.toLowerCase());
        const isCorrect = userWords.every((word, index) => word === correctWords[index]);
        
        if (isCorrect) {
            this.clearError('verification-error');
            this.hideModal('wallet-setup-modal');
            this.showMainScreen();
            this.updateWalletDisplay();
            this.showToast('Wallet created successfully!', 'success');
        } else {
            this.showInlineError('verification-error', 'Incorrect words. Please check and try again.');
        }
    }
    
    /**
     * Get random positions for verification
     */
    getRandomPositions(total, count) {
        const positions = [];
        while (positions.length < count) {
            const pos = Math.floor(Math.random() * total);
            if (!positions.includes(pos)) {
                positions.push(pos);
            }
        }
        return positions.sort((a, b) => a - b);
    }
    
    /**
     * Load and apply settings
     */
    async loadSettings() {
        try {
            const settings = await this.walletManager.loadFromStorage('qnet_settings') || {};
            
            // Apply language setting (default: English)
            if (settings.language) {
                await this.setLanguage(settings.language);
                const languageSelect = this.getElement('language-select');
                if (languageSelect) languageSelect.value = settings.language;
            } else {
                // Set default language to English
                const languageSelect = this.getElement('language-select');
                if (languageSelect) languageSelect.value = 'en';
            }
            
            // Apply auto-lock setting
            if (settings.autoLockTimer !== undefined) {
                this.setAutoLockTimer(settings.autoLockTimer);
                const autoLockSelect = this.getElement('autolock-select');
                if (autoLockSelect) autoLockSelect.value = settings.autoLockTimer;
            }
            
            // Apply network setting
            if (settings.network) {
                const networkSelect = this.getElement('network-select');
                if (networkSelect) networkSelect.value = settings.network;
            }
            
            // Apply checkbox settings
            const checkboxes = ['biometric-auth', 'enable-dapp-browser', 'enable-push-notifications'];
            checkboxes.forEach(id => {
                const checkbox = this.getElement(id);
                if (checkbox && settings[id] !== undefined) {
                    checkbox.checked = settings[id];
                }
            });
            
        } catch (error) {
            console.error('Failed to load settings:', error);
        }
    }
    
    /**
     * Save settings
     */
    async saveSettings() {
        try {
            const settings = {
                language: this.getElement('language-select')?.value || 'en',
                autoLockTimer: parseInt(this.getElement('autolock-select')?.value || '0'),
                network: this.getElement('network-select')?.value || 'devnet',
                'biometric-auth': this.getElement('biometric-auth')?.checked || false,
                'enable-dapp-browser': this.getElement('enable-dapp-browser')?.checked || true,
                'enable-push-notifications': this.getElement('enable-push-notifications')?.checked || false,
            };
            
            await this.walletManager.saveToStorage('qnet_settings', settings);
            this.showToast('Settings saved successfully', 'success');
            
            // Apply settings immediately
            await this.setLanguage(settings.language);
            this.setAutoLockTimer(settings.autoLockTimer);
            
        } catch (error) {
            this.showToast('Failed to save settings', 'error');
        }
    }
    
    /**
     * Set language
     */
    async setLanguage(languageCode) {
        try {
            // Import i18n module
            const { setLanguage } = await import('../i18n/index.js');
            await setLanguage(languageCode);
            
            // Update UI texts
            this.updateUITexts();
            
        } catch (error) {
            console.error('Failed to set language:', error);
        }
    }
    
    /**
     * Update UI texts based on current language
     */
    updateUITexts() {
        // This would update all UI texts based on current language
        // Implementation depends on i18n structure
    }
    
    /**
     * Set auto-lock timer
     */
    setAutoLockTimer(seconds) {
        if (this.autoLockTimer) {
            clearTimeout(this.autoLockTimer);
        }
        
        if (seconds > 0) {
            this.autoLockTimer = setTimeout(() => {
                this.walletManager.lock();
                this.showLockedScreen();
                this.showToast('Wallet auto-locked for security', 'info');
            }, seconds * 1000);
        }
    }
    
    /**
     * Reset auto-lock timer (call on user activity)
     */
    resetAutoLockTimer() {
        const settings = this.walletManager.loadFromStorage('qnet_settings');
        if (settings && settings.autoLockTimer > 0) {
            this.setAutoLockTimer(settings.autoLockTimer);
        }
    }
    
    /**
     * Show connected sites management
     */
    async showConnectedSites() {
        try {
            const sites = await this.walletManager.getConnectedSites();
            
            const modal = document.createElement('div');
            modal.className = 'modal-overlay';
            modal.style.cssText = `
                position: fixed;
                inset: 0;
                background: rgba(0,0,0,0.7);
                backdrop-filter: blur(5px);
                z-index: 10000;
                display: flex;
                justify-content: center;
                align-items: center;
            `;
            
            const content = document.createElement('div');
            content.className = 'modal-box';
            content.style.cssText = `
                background: var(--background-secondary);
                border: 1px solid var(--border-color);
                border-radius: 12px;
                padding: 24px;
                max-width: 500px;
                width: 90%;
                max-height: 80vh;
                overflow-y: auto;
            `;
            
            content.innerHTML = `
                <div class="modal-header">
                    <h3>Connected Sites</h3>
                    <button id="close-sites-modal">✕</button>
                </div>
                <div class="sites-list">
                    ${sites.length === 0 ? '<p>No connected sites</p>' : sites.map(site => `
                        <div class="site-item">
                            <div class="site-info">
                                <strong>${site.origin}</strong>
                                <small>Connected: ${new Date(site.connectedAt).toLocaleDateString()}</small>
                            </div>
                            <button class="disconnect-site" data-origin="${site.origin}">Disconnect</button>
                        </div>
                    `).join('')}
                </div>
            `;
            
            modal.appendChild(content);
            document.body.appendChild(modal);
            
            // Handle close
            content.querySelector('#close-sites-modal').onclick = () => modal.remove();
            modal.onclick = (e) => {
                if (e.target === modal) modal.remove();
            };
            
            // Handle disconnect
            content.querySelectorAll('.disconnect-site').forEach(btn => {
                btn.onclick = async () => {
                    const origin = btn.dataset.origin;
                    await this.walletManager.disconnectSite(origin);
                    modal.remove();
                    this.showToast(`Disconnected from ${origin}`, 'success');
                };
            });
            
        } catch (error) {
            this.showToast('Failed to load connected sites', 'error');
        }
    }

    /**
     * Show toast notification
     */
    showToast(message, type = 'info') {
        // Remove existing toast
        if (this.currentToast) {
            this.currentToast.remove();
        }

        // Create toast element
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;
        
        // Apply toast CSS class instead of inline styles
        toast.classList.add('toast-notification');

        // Add animation keyframes
        if (!document.getElementById('toast-styles')) {
            const style = document.createElement('style');
            style.id = 'toast-styles';
            style.textContent = `
                @keyframes slideIn {
                    from { transform: translateX(100%); opacity: 0; }
                    to { transform: translateX(0); opacity: 1; }
                }
                @keyframes slideOut {
                    from { transform: translateX(0); opacity: 1; }
                    to { transform: translateX(100%); opacity: 0; }
                }
            `;
            document.head.appendChild(style);
        }

        document.body.appendChild(toast);
        this.currentToast = toast;

        // Auto remove after 3 seconds
        setTimeout(() => {
            if (toast.parentNode) {
                toast.style.animation = 'slideOut 0.3s ease';
                setTimeout(() => {
                    if (toast.parentNode) {
                        toast.remove();
                    }
                    if (this.currentToast === toast) {
                        this.currentToast = null;
                    }
                }, 300);
            }
        }, 3000);
    }

    /**
     * Show inline error message
     */
    showInlineError(errorId, message) {
        let errorElement = this.getElement(errorId);
        
        if (!errorElement) {
            // Create error element if it doesn't exist
            errorElement = document.createElement('div');
            errorElement.id = errorId;
            errorElement.className = 'inline-error';
            errorElement.classList.add('inline-error-dynamic');
            
            // Find the appropriate parent to insert the error
            const parentElement = this.findErrorParent(errorId);
            if (parentElement) {
                parentElement.appendChild(errorElement);
            }
        }
        
        errorElement.textContent = message;
        errorElement.classList.remove('hidden');
        errorElement.classList.add('error-visible');
    }

    /**
     * Clear inline error
     */
    clearError(errorId) {
        const errorElement = this.getElement(errorId);
        if (errorElement) {
            errorElement.classList.add('hidden');
            errorElement.classList.remove('error-visible');
            errorElement.textContent = '';
        }
    }

    /**
     * Find appropriate parent for error message
     */
    findErrorParent(errorId) {
        if (errorId === 'password-error') {
            return this.getElement('password-input')?.parentNode;
        }
        if (errorId === 'password-create-error') {
            return this.getElement('confirm-password')?.parentNode;
        }
        if (errorId === 'import-error') {
            return this.getElement('import-password')?.parentNode;
        }
        return document.body;
    }

    /**
     * Show confirmation modal
     */
    async showConfirmModal(title, message) {
        return new Promise((resolve) => {
            // Create modal overlay
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            overlay.classList.add('confirm-overlay');

            // Create modal box
            const modal = document.createElement('div');
            modal.className = 'confirm-modal';
            modal.classList.add('confirm-modal-box');

            modal.innerHTML = `
                <h3 class="confirm-title">${title}</h3>
                <p class="confirm-message">${message}</p>
                <div class="confirm-actions">
                    <button id="confirm-cancel" class="qnet-button confirm-cancel">Cancel</button>
                    <button id="confirm-ok" class="qnet-button primary">Confirm</button>
                </div>
            `;

            overlay.appendChild(modal);
            document.body.appendChild(overlay);

            // Handle buttons
            modal.querySelector('#confirm-cancel').onclick = () => {
                overlay.remove();
                resolve(false);
            };

            modal.querySelector('#confirm-ok').onclick = () => {
                overlay.remove();
                resolve(true);
            };

            // Handle overlay click
            overlay.onclick = (e) => {
                if (e.target === overlay) {
                    overlay.remove();
                    resolve(false);
                }
            };
        });
    }

    /**
     * Shorten address for display
     */
    shortenAddress(address, chars = 6) {
        if (!address || address.length < chars * 2) return address;
        return `${address.slice(0, chars)}...${address.slice(-chars)}`;
    }

    // Utility methods for DOM manipulation

    /**
     * Get element by ID
     */
    getElement(id) {
        return document.getElementById(id);
    }

    /**
     * Show element by removing hidden class
     */
    showElement(id) {
        const element = this.getElement(id);
        if (element) {
            element.classList.remove('hidden');
        }
    }

    /**
     * Hide element by adding hidden class
     */
    hideElement(id) {
        const element = this.getElement(id);
        if (element) {
            element.classList.add('hidden');
        }
    }

    /**
     * Set text content of element
     */
    setText(id, text) {
        const element = this.getElement(id);
        if (element) {
            element.textContent = text;
        }
    }

    /**
     * Focus on element
     */
    focusElement(id) {
        const element = this.getElement(id);
        if (element) {
            element.focus();
        }
    }

    /**
     * Clear input value
     */
    clearInput(id) {
        const element = this.getElement(id);
        if (element) {
            element.value = '';
        }
    }

    /**
     * Get input value
     */
    getInputValue(id) {
        const element = this.getElement(id);
        return element ? element.value : '';
    }

    /**
     * Set button state
     */
    setButtonState(id, disabled, text) {
        const button = this.getElement(id);
        if (button) {
            button.disabled = disabled;
            if (text) {
                button.textContent = text;
            }
        }
    }
} 