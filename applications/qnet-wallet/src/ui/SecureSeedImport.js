/**
 * Secure Seed Import UI Component
 * Production-ready interface for importing seed phrases from other wallets
 * Real-time validation with comprehensive security checks
 */

import { secureBIP39 } from '../crypto/ProductionBIP39.js';

export class SecureSeedImport {
    constructor() {
        this.currentValidation = null;
        this.isValidating = false;
    }

    /**
     * Create secure seed import UI
     */
    createImportUI() {
        return `
            <div class="secure-seed-import">
                <div class="import-header">
                    <h3>Import from Other Wallet</h3>
                    <p>Enter your seed phrase from MetaMask, Trust Wallet, Phantom, Solflare, or other BIP39 wallets</p>
                </div>
                
                <div class="seed-input-container">
                    <label for="seed-phrase-input">Seed Phrase (12 or 24 words)</label>
                    <textarea 
                        id="seed-phrase-input" 
                        placeholder="Enter your seed phrase here..."
                        class="seed-input"
                        spellcheck="false"
                        autocomplete="off"
                        autocorrect="off"
                        rows="4">
                    </textarea>
                    <div class="input-hint">
                        Words should be separated by spaces. Copy and paste from your other wallet.
                    </div>
                </div>
                
                <div class="validation-status" id="validation-status">
                    <div class="validation-header">Security Validation</div>
                    <div class="validation-items">
                        <div class="validation-item" id="word-count-check">
                            <span class="check-icon">⏳</span>
                            <span class="check-text">Word count (12 or 24 words)</span>
                        </div>
                        <div class="validation-item" id="wordlist-check">
                            <span class="check-icon">⏳</span>
                            <span class="check-text">All words in BIP39 wordlist</span>
                        </div>
                        <div class="validation-item" id="checksum-check">
                            <span class="check-icon">⏳</span>
                            <span class="check-text">Valid BIP39 checksum</span>
                        </div>
                        <div class="validation-item" id="entropy-check">
                            <span class="check-icon">⏳</span>
                            <span class="check-text">Sufficient entropy (128+ bits)</span>
                        </div>
                    </div>
                </div>
                
                <div class="entropy-info" id="entropy-info" style="display: none;">
                    <div class="entropy-bar">
                        <div class="entropy-fill" id="entropy-fill"></div>
                    </div>
                    <div class="entropy-text" id="entropy-text"></div>
                </div>
                
                <div class="password-section">
                    <label for="import-password">Set Wallet Password</label>
                    <input 
                        type="password" 
                        id="import-password" 
                        placeholder="Create a strong password"
                        class="password-input"
                        minlength="8">
                    <div class="password-strength" id="password-strength"></div>
                </div>
                
                <div class="import-actions">
                    <button id="import-wallet-btn" class="import-btn" disabled>
                        Import Wallet
                    </button>
                    <button id="cancel-import-btn" class="cancel-btn">
                        Cancel
                    </button>
                </div>
                
                <div class="security-notice">
                    <div class="notice-icon">🔒</div>
                    <div class="notice-text">
                        Your seed phrase is validated locally and never sent to any server. 
                        QNet Wallet uses industry-standard BIP39 validation.
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Initialize event listeners
     */
    initialize() {
        const seedInput = document.getElementById('seed-phrase-input');
        const passwordInput = document.getElementById('import-password');
        const importBtn = document.getElementById('import-wallet-btn');
        const cancelBtn = document.getElementById('cancel-import-btn');

        if (seedInput) {
            seedInput.addEventListener('input', (e) => this.validateRealTime(e.target.value));
            seedInput.addEventListener('paste', (e) => {
                setTimeout(() => this.validateRealTime(e.target.value), 100);
            });
        }

        if (passwordInput) {
            passwordInput.addEventListener('input', (e) => this.validatePassword(e.target.value));
        }

        if (importBtn) {
            importBtn.addEventListener('click', () => this.handleImport());
        }

        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => this.handleCancel());
        }
    }

    /**
     * Real-time seed phrase validation
     */
    async validateRealTime(inputPhrase) {
        if (this.isValidating) return;
        this.isValidating = true;

        try {
            const validation = secureBIP39.validateRealTime(inputPhrase);
            this.currentValidation = validation;
            
            this.updateValidationUI(validation);
            this.updateImportButton();
            
        } catch (error) {
            console.error('Validation error:', error);
        } finally {
            this.isValidating = false;
        }
    }

    /**
     * Update validation UI elements
     */
    updateValidationUI(validation) {
        // Update word count check
        this.updateValidationItem('word-count-check', validation.hasValidLength);
        
        // Update wordlist check
        this.updateValidationItem('wordlist-check', validation.allWordsValid);
        
        // Update checksum check
        this.updateValidationItem('checksum-check', validation.checksumValid);
        
        // Update entropy check
        const hasMinEntropy = validation.entropyBits >= 128;
        this.updateValidationItem('entropy-check', hasMinEntropy);
        
        // Update entropy info
        if (validation.entropyBits > 0) {
            this.updateEntropyInfo(validation.entropyBits);
        }
    }

    /**
     * Update individual validation item
     */
    updateValidationItem(itemId, isValid) {
        const item = document.getElementById(itemId);
        if (!item) return;

        const icon = item.querySelector('.check-icon');
        const text = item.querySelector('.check-text');
        
        if (isValid) {
            icon.textContent = '✅';
            item.classList.add('valid');
            item.classList.remove('invalid');
        } else {
            icon.textContent = '❌';
            item.classList.add('invalid');
            item.classList.remove('valid');
        }
    }

    /**
     * Update entropy information display
     */
    updateEntropyInfo(entropyBits) {
        const entropyInfo = document.getElementById('entropy-info');
        const entropyFill = document.getElementById('entropy-fill');
        const entropyText = document.getElementById('entropy-text');
        
        if (!entropyInfo || !entropyFill || !entropyText) return;

        entropyInfo.style.display = 'block';
        
        const percentage = Math.min((entropyBits / 256) * 100, 100);
        entropyFill.style.width = `${percentage}%`;
        
        const strength = secureBIP39.getEntropyStrength(entropyBits);
        entropyText.textContent = `${entropyBits} bits - ${strength}`;
        
        // Color coding
        if (entropyBits >= 256) {
            entropyFill.style.background = '#4caf50'; // Green
        } else if (entropyBits >= 192) {
            entropyFill.style.background = '#8bc34a'; // Light green
        } else if (entropyBits >= 128) {
            entropyFill.style.background = '#ffc107'; // Yellow
        } else {
            entropyFill.style.background = '#f44336'; // Red
        }
    }

    /**
     * Validate password strength
     */
    validatePassword(password) {
        const strengthEl = document.getElementById('password-strength');
        if (!strengthEl) return;

        if (password.length === 0) {
            strengthEl.textContent = '';
            return;
        }

        let score = 0;
        let feedback = [];

        if (password.length >= 8) score++;
        else feedback.push('At least 8 characters');

        if (/[A-Z]/.test(password)) score++;
        else feedback.push('Uppercase letter');

        if (/[a-z]/.test(password)) score++;
        else feedback.push('Lowercase letter');

        if (/\d/.test(password)) score++;
        else feedback.push('Number');

        if (/[!@#$%^&*]/.test(password)) score++;
        else feedback.push('Special character');

        const strength = score >= 4 ? 'Strong' : score >= 3 ? 'Medium' : 'Weak';
        const color = score >= 4 ? '#4caf50' : score >= 3 ? '#ffc107' : '#f44336';

        strengthEl.innerHTML = `
            <span style="color: ${color}">Password strength: ${strength}</span>
            ${feedback.length > 0 ? `<br><small>Missing: ${feedback.join(', ')}</small>` : ''}
        `;

        this.updateImportButton();
    }

    /**
     * Update import button state
     */
    updateImportButton() {
        const importBtn = document.getElementById('import-wallet-btn');
        const passwordInput = document.getElementById('import-password');
        
        if (!importBtn || !passwordInput) return;

        const hasValidSeed = this.currentValidation && 
                            this.currentValidation.checksumValid && 
                            this.currentValidation.entropyBits >= 128;
        
        const hasValidPassword = passwordInput.value.length >= 8;

        importBtn.disabled = !(hasValidSeed && hasValidPassword);
    }

    /**
     * Handle wallet import
     */
    async handleImport() {
        const seedInput = document.getElementById('seed-phrase-input');
        const passwordInput = document.getElementById('import-password');
        
        if (!seedInput || !passwordInput) return;

        const seedPhrase = seedInput.value.trim();
        const password = passwordInput.value;

        try {
            // Final validation
            const validation = secureBIP39.validateImportedSeed(seedPhrase);
            if (!validation.valid) {
                this.showError(validation.error);
                return;
            }

            // Import wallet
            const walletData = await secureBIP39.importFromExternalWallet(seedPhrase, password);
            
            // Clear sensitive data
            seedInput.value = '';
            passwordInput.value = '';
            
            // Trigger success callback
            if (this.onImportSuccess) {
                this.onImportSuccess(walletData);
            }
            
            this.showSuccess('Wallet imported successfully!');
            
        } catch (error) {
            this.showError(`Import failed: ${error.message}`);
        }
    }

    /**
     * Handle cancel
     */
    handleCancel() {
        if (this.onCancel) {
            this.onCancel();
        }
    }

    /**
     * Show error message
     */
    showError(message) {
        // Implementation depends on your toast/notification system
        console.error('Import error:', message);
    }

    /**
     * Show success message
     */
    showSuccess(message) {
        // Implementation depends on your toast/notification system
        console.log('Import success:', message);
    }

    /**
     * Set success callback
     */
    onImportSuccess(callback) {
        this.onImportSuccess = callback;
    }

    /**
     * Set cancel callback
     */
    onCancel(callback) {
        this.onCancel = callback;
    }
}

export default SecureSeedImport; 