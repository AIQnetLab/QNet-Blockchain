// Gas Settings Component for QNet Wallet

export class GasSettings {
    constructor() {
        this.gasPrice = 10; // Default gas price
        this.gasLimit = 21000; // Default gas limit
        this.mode = 'standard'; // 'slow', 'standard', 'fast', 'custom'
        this.estimatedFee = 0;
    }
    
    // Create gas settings UI
    createUI() {
        const container = document.createElement('div');
        container.className = 'gas-settings';
        container.innerHTML = `
            <div class="gas-settings-header">
                <h3>Gas Settings</h3>
                <span class="gas-info-icon" title="Gas fees ensure your transaction is processed by the network">ⓘ</span>
            </div>
            
            <div class="gas-mode-selector">
                <button class="gas-mode-btn" data-mode="slow">
                    <span class="mode-label">Slow</span>
                    <span class="mode-time">~10 min</span>
                </button>
                <button class="gas-mode-btn active" data-mode="standard">
                    <span class="mode-label">Standard</span>
                    <span class="mode-time">~3 min</span>
                </button>
                <button class="gas-mode-btn" data-mode="fast">
                    <span class="mode-label">Fast</span>
                    <span class="mode-time">~30 sec</span>
                </button>
                <button class="gas-mode-btn" data-mode="custom">
                    <span class="mode-label">Custom</span>
                </button>
            </div>
            
            <div class="gas-details" style="display: none;">
                <div class="gas-input-group">
                    <label for="gas-price">Gas Price (Gwei)</label>
                    <input type="number" id="gas-price" min="1" value="${this.gasPrice}">
                </div>
                <div class="gas-input-group">
                    <label for="gas-limit">Gas Limit</label>
                    <input type="number" id="gas-limit" min="21000" value="${this.gasLimit}">
                </div>
            </div>
            
            <div class="gas-summary">
                <div class="summary-row">
                    <span>Estimated Fee:</span>
                    <span class="estimated-fee">0.00021 QNC</span>
                </div>
                <div class="summary-row">
                    <span>Max Fee:</span>
                    <span class="max-fee">0.00021 QNC</span>
                </div>
            </div>
        `;
        
        // Add styles
        this.addStyles();
        
        // Add event listeners
        this.attachEventListeners(container);
        
        return container;
    }
    
    // Add styles
    addStyles() {
        if (document.getElementById('gas-settings-styles')) return;
        
        const style = document.createElement('style');
        style.id = 'gas-settings-styles';
        style.textContent = `
            .gas-settings {
                background: #f8f9fa;
                border-radius: 12px;
                padding: 16px;
                margin: 16px 0;
            }
            
            .gas-settings-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 16px;
            }
            
            .gas-settings-header h3 {
                margin: 0;
                font-size: 16px;
                color: #333;
            }
            
            .gas-info-icon {
                cursor: help;
                color: #666;
                font-size: 18px;
            }
            
            .gas-mode-selector {
                display: grid;
                grid-template-columns: repeat(4, 1fr);
                gap: 8px;
                margin-bottom: 16px;
            }
            
            .gas-mode-btn {
                background: white;
                border: 2px solid #e0e0e0;
                border-radius: 8px;
                padding: 12px 8px;
                cursor: pointer;
                transition: all 0.2s;
                text-align: center;
            }
            
            .gas-mode-btn:hover {
                border-color: #4CAF50;
            }
            
            .gas-mode-btn.active {
                background: #4CAF50;
                border-color: #4CAF50;
                color: white;
            }
            
            .mode-label {
                display: block;
                font-weight: 600;
                font-size: 14px;
            }
            
            .mode-time {
                display: block;
                font-size: 12px;
                opacity: 0.8;
                margin-top: 4px;
            }
            
            .gas-details {
                background: white;
                border-radius: 8px;
                padding: 16px;
                margin-bottom: 16px;
            }
            
            .gas-input-group {
                margin-bottom: 12px;
            }
            
            .gas-input-group:last-child {
                margin-bottom: 0;
            }
            
            .gas-input-group label {
                display: block;
                font-size: 14px;
                color: #666;
                margin-bottom: 4px;
            }
            
            .gas-input-group input {
                width: 100%;
                padding: 8px 12px;
                border: 1px solid #e0e0e0;
                border-radius: 6px;
                font-size: 14px;
            }
            
            .gas-input-group input:focus {
                outline: none;
                border-color: #4CAF50;
            }
            
            .gas-summary {
                background: white;
                border-radius: 8px;
                padding: 12px 16px;
            }
            
            .summary-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                font-size: 14px;
                margin-bottom: 8px;
            }
            
            .summary-row:last-child {
                margin-bottom: 0;
            }
            
            .estimated-fee, .max-fee {
                font-weight: 600;
                color: #4CAF50;
            }
        `;
        document.head.appendChild(style);
    }
    
    // Attach event listeners
    attachEventListeners(container) {
        // Mode buttons
        const modeButtons = container.querySelectorAll('.gas-mode-btn');
        modeButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.handleModeChange(e.target.closest('.gas-mode-btn').dataset.mode, container);
            });
        });
        
        // Custom inputs
        const gasPriceInput = container.querySelector('#gas-price');
        const gasLimitInput = container.querySelector('#gas-limit');
        
        gasPriceInput.addEventListener('input', (e) => {
            this.gasPrice = parseInt(e.target.value) || 1;
            this.updateEstimates(container);
        });
        
        gasLimitInput.addEventListener('input', (e) => {
            this.gasLimit = parseInt(e.target.value) || 21000;
            this.updateEstimates(container);
        });
    }
    
    // Handle mode change
    handleModeChange(mode, container) {
        this.mode = mode;
        
        // Update active button
        container.querySelectorAll('.gas-mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });
        
        // Show/hide custom inputs
        const gasDetails = container.querySelector('.gas-details');
        gasDetails.style.display = mode === 'custom' ? 'block' : 'none';
        
        // Update gas values based on mode
        switch (mode) {
            case 'slow':
                this.gasPrice = 5;
                this.gasLimit = 21000;
                break;
            case 'standard':
                this.gasPrice = 10;
                this.gasLimit = 21000;
                break;
            case 'fast':
                this.gasPrice = 20;
                this.gasLimit = 21000;
                break;
        }
        
        // Update inputs if custom mode
        if (mode === 'custom') {
            container.querySelector('#gas-price').value = this.gasPrice;
            container.querySelector('#gas-limit').value = this.gasLimit;
        }
        
        this.updateEstimates(container);
    }
    
    // Update fee estimates
    updateEstimates(container) {
        const fee = (this.gasPrice * this.gasLimit) / 1e9; // Convert from Gwei
        this.estimatedFee = fee;
        
        container.querySelector('.estimated-fee').textContent = `${fee.toFixed(6)} QNC`;
        container.querySelector('.max-fee').textContent = `${fee.toFixed(6)} QNC`;
    }
    
    // Get current gas settings
    getSettings() {
        return {
            gasPrice: this.gasPrice,
            gasLimit: this.gasLimit,
            mode: this.mode,
            estimatedFee: this.estimatedFee
        };
    }
    
    // Set gas settings
    setSettings(settings) {
        if (settings.gasPrice) this.gasPrice = settings.gasPrice;
        if (settings.gasLimit) this.gasLimit = settings.gasLimit;
        if (settings.mode) this.mode = settings.mode;
    }
    
    // Fetch recommended gas prices from network
    async fetchRecommendedPrices(networkManager) {
        try {
            const gasPrice = await networkManager.getGasPrice();
            
            // Calculate different speeds
            this.slowPrice = Math.floor(gasPrice * 0.8);
            this.standardPrice = gasPrice;
            this.fastPrice = Math.floor(gasPrice * 1.5);
            
            return {
                slow: this.slowPrice,
                standard: this.standardPrice,
                fast: this.fastPrice
            };
        } catch (error) {
            console.error('Error fetching gas prices:', error);
            return null;
        }
    }
}

// Export for use in wallet
window.GasSettings = GasSettings; 