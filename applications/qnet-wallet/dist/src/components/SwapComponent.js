/**
 * Swap Component for QNet Wallet
 * Handles token swaps with 0.5% fee collection
 */

import { calculateSwapFee, getFeeRecipient, getAllTokens } from '../config/FeeConfig.js';

export class SwapComponent {
    constructor(container, network = 'solana') {
        this.container = container;
        this.network = network;
        this.tokens = {};
        this.fromToken = null;
        this.toToken = null;
        this.amount = 0;
        this.slippage = 0.5; // 0.5% default slippage
        
        this.init();
    }

    init() {
        this.loadTokens();
        this.render();
        this.bindEvents();
    }

    loadTokens() {
        this.tokens = getAllTokens(this.network);
    }

    render() {
        if (!this.container) return;

        this.container.innerHTML = `
            <div class="swap-component">
                <div class="swap-header">
                    <h3>Swap Tokens (${this.network.toUpperCase()})</h3>
                    <div class="swap-settings">
                        <button class="settings-btn" id="swap-settings">⚙️</button>
                    </div>
                </div>
                
                <!-- From Token Section -->
                <div class="swap-section from-section">
                    <div class="section-label">From</div>
                    <div class="token-input-container">
                        <input type="number" 
                               id="from-amount" 
                               class="amount-input" 
                               placeholder="0.0"
                               step="any"
                               min="0">
                        <div class="token-selector" id="from-token-selector">
                            ${this.renderTokenSelector('from')}
                        </div>
                    </div>
                    <div class="token-balance" id="from-balance">
                        Balance: 0.0000
                    </div>
                </div>
                
                <!-- Swap Direction Button -->
                <div class="swap-direction">
                    <button class="swap-direction-btn" id="swap-direction-btn">⇅</button>
                </div>
                
                <!-- To Token Section -->
                <div class="swap-section to-section">
                    <div class="section-label">To</div>
                    <div class="token-input-container">
                        <input type="number" 
                               id="to-amount" 
                               class="amount-input" 
                               placeholder="0.0"
                               readonly>
                        <div class="token-selector" id="to-token-selector">
                            ${this.renderTokenSelector('to')}
                        </div>
                    </div>
                    <div class="token-balance" id="to-balance">
                        Balance: 0.0000
                    </div>
                </div>
                
                <!-- Fee Information -->
                <div class="fee-information hidden" id="fee-info">
                    <div class="fee-item">
                        <span>Platform Fee (0.5%)</span>
                        <span id="platform-fee-amount">0.0000</span>
                    </div>
                    <div class="fee-item">
                        <span>Network Fee</span>
                        <span id="network-fee-amount">~$0.01</span>
                    </div>
                    <div class="fee-item">
                        <span>Slippage Tolerance</span>
                        <span id="slippage-display">0.5%</span>
                    </div>
                    <div class="fee-item total-fee">
                        <span>You'll Receive (minimum)</span>
                        <span id="minimum-received">0.0000</span>
                    </div>
                </div>
                
                <!-- Swap Button -->
                <button class="swap-btn" id="swap-btn" disabled>
                    Enter Amount
                </button>
            </div>
        `;
    }

    renderTokenSelector(type) {
        const selectedToken = type === 'from' ? this.fromToken : this.toToken;
        const tokenOptions = Object.entries(this.tokens).map(([symbol, token]) => {
            return `
                <option value="${symbol}" ${selectedToken === symbol ? 'selected' : ''}>
                    ${symbol} - ${token.name}
                </option>
            `;
        }).join('');

        return `
            <select class="token-select" id="${type}-token-select">
                <option value="">Select Token</option>
                ${tokenOptions}
            </select>
        `;
    }

    bindEvents() {
        // Amount input
        const fromAmountInput = document.getElementById('from-amount');
        if (fromAmountInput) {
            fromAmountInput.addEventListener('input', (e) => this.handleAmountChange(e.target.value));
        }

        // Token selectors
        const fromTokenSelect = document.getElementById('from-token-select');
        const toTokenSelect = document.getElementById('to-token-select');
        
        if (fromTokenSelect) {
            fromTokenSelect.addEventListener('change', (e) => this.handleFromTokenChange(e.target.value));
        }
        
        if (toTokenSelect) {
            toTokenSelect.addEventListener('change', (e) => this.handleToTokenChange(e.target.value));
        }

        // Swap direction
        const swapDirectionBtn = document.getElementById('swap-direction-btn');
        if (swapDirectionBtn) {
            swapDirectionBtn.addEventListener('click', () => this.swapDirection());
        }

        // Swap button
        const swapBtn = document.getElementById('swap-btn');
        if (swapBtn) {
            swapBtn.addEventListener('click', () => this.executeSwap());
        }
    }

    handleAmountChange(amount) {
        this.amount = parseFloat(amount) || 0;
        this.updateCalculations();
    }

    handleFromTokenChange(token) {
        this.fromToken = token;
        this.updateCalculations();
    }

    handleToTokenChange(token) {
        this.toToken = token;
        this.updateCalculations();
    }

    swapDirection() {
        const temp = this.fromToken;
        this.fromToken = this.toToken;
        this.toToken = temp;
        
        // Update UI
        const fromSelect = document.getElementById('from-token-select');
        const toSelect = document.getElementById('to-token-select');
        
        if (fromSelect) fromSelect.value = this.fromToken || '';
        if (toSelect) toSelect.value = this.toToken || '';
        
        this.updateCalculations();
    }

    updateCalculations() {
        if (!this.amount || !this.fromToken || !this.toToken) {
            this.hideCalculations();
            return;
        }

        // Calculate platform fee (0.5%)
        const platformFee = calculateSwapFee(this.amount, this.network);
        const amountAfterFee = this.amount - platformFee;
        
        // Mock exchange rate calculation (1:1 for simplicity)
        const exchangeRate = this.getExchangeRate(this.fromToken, this.toToken);
        const toAmount = amountAfterFee * exchangeRate;
        
        // Update UI
        document.getElementById('to-amount').value = toAmount.toFixed(6);
        document.getElementById('platform-fee-amount').textContent = 
            `${platformFee.toFixed(6)} ${this.fromToken}`;
        
        // Update swap button
        const swapBtn = document.getElementById('swap-btn');
        if (swapBtn) {
            swapBtn.disabled = false;
            swapBtn.textContent = `Swap ${this.fromToken} for ${this.toToken}`;
        }
        
        this.showCalculations();
    }

    getExchangeRate(fromToken, toToken) {
        // Mock exchange rates - in production, this would fetch from DEX APIs
        const rates = {
            'SOL': { 'USDC': 156.78, 'USDT': 156.85, '1DEV': 1000 },
            'USDC': { 'SOL': 0.00638, 'USDT': 1.001, '1DEV': 6.38 },
            'USDT': { 'SOL': 0.00637, 'USDC': 0.999, '1DEV': 6.37 },
            '1DEV': { 'SOL': 0.001, 'USDC': 0.157, 'USDT': 0.157 },
            'QNC': { 'SOL': 0.01, 'USDC': 1.57, 'USDT': 1.57 }
        };
        
        return rates[fromToken]?.[toToken] || 1;
    }

    showCalculations() {
        const feeInfo = document.getElementById('fee-info');
        if (feeInfo) feeInfo.style.display = 'block';
    }

    hideCalculations() {
        const feeInfo = document.getElementById('fee-info');
        if (feeInfo) feeInfo.style.display = 'none';
        
        // Reset swap button
        const swapBtn = document.getElementById('swap-btn');
        if (swapBtn) {
            swapBtn.disabled = true;
            swapBtn.textContent = 'Enter Amount';
        }
    }

    async executeSwap() {
        if (!this.amount || !this.fromToken || !this.toToken) {
            alert('Please fill in all fields');
            return;
        }

        try {
            // Calculate fees
            const platformFee = calculateSwapFee(this.amount, this.network);
            const feeRecipient = getFeeRecipient(this.network);
            
            console.log('🔄 Executing swap with 0.5% fee...');
            console.log(`Platform fee: ${platformFee} ${this.fromToken}`);
            console.log(`Fee recipient: ${feeRecipient}`);
            
            // Emit swap event for parent component to handle
            const swapData = {
                fromToken: this.fromToken,
                toToken: this.toToken,
                amount: this.amount,
                platformFee,
                feeRecipient,
                network: this.network
            };
            
            window.dispatchEvent(new CustomEvent('token-swap-execute', { 
                detail: swapData 
            }));
            
            alert(`✅ Swap completed!\nFee collected: ${platformFee.toFixed(6)} ${this.fromToken}\nSent to: ${feeRecipient}`);
            
        } catch (error) {
            console.error('Swap failed:', error);
            alert('Swap failed: ' + error.message);
        }
    }

    // Public methods
    updateNetwork(network) {
        this.network = network;
        this.loadTokens();
        this.render();
    }
}

// Export for use in other components
window.SwapComponent = SwapComponent;