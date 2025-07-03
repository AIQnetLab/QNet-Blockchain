/**
 * QNet Wallet Setup - Production Setup Flow
 * Handles wallet creation and import in a dedicated window
 */

// Import crypto utilities
import { SecureCrypto } from '../src/crypto/SecureCrypto.js';
import { WalletManager } from '../src/wallet/WalletManager.js';

class WalletSetup {
    constructor() {
        this.currentStep = 0;
        this.steps = ['welcome', 'password', 'seed-display', 'verification', 'success'];
        this.setupType = null; // 'create' or 'import'
        this.password = null;
        this.mnemonic = null;
        this.walletData = null;
        this.verificationWords = [];
        this.verificationAnswers = {};
        
        this.init();
    }

    init() {
        this.bindEvents();
        this.showStep('welcome');
    }

    bindEvents() {
        // Close button
        document.getElementById('close-setup').addEventListener('click', () => {
            this.closeSetup();
        });

        // Step 1: Welcome
        document.getElementById('create-new-wallet').addEventListener('click', () => {
            this.setupType = 'create';
            this.nextStep();
        });

        document.getElementById('import-existing-wallet').addEventListener('click', () => {
            this.setupType = 'import';
            this.nextStep();
        });

        // Step 2: Password
        document.getElementById('password-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handlePasswordSubmit();
        });

        document.getElementById('back-to-welcome').addEventListener('click', () => {
            this.previousStep();
        });

        // Password validation
        document.getElementById('new-password').addEventListener('input', () => {
            this.validatePassword();
        });

        document.getElementById('confirm-password').addEventListener('input', () => {
            this.validatePassword();
        });

        // Step 3a: Seed Display (Create)
        document.getElementById('copy-seed').addEventListener('click', () => {
            this.copySeedPhrase();
        });

        document.getElementById('download-seed').addEventListener('click', () => {
            this.downloadSeedPhrase();
        });

        document.getElementById('back-to-password').addEventListener('click', () => {
            this.previousStep();
        });

        document.getElementById('continue-to-verify').addEventListener('click', () => {
            this.nextStep();
        });

        // Step 3b: Import
        document.getElementById('import-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleImportSubmit();
        });

        document.getElementById('back-to-password-import').addEventListener('click', () => {
            this.previousStep();
        });

        document.getElementById('seed-phrase-input').addEventListener('input', () => {
            this.validateImportPhrase();
        });

        // Step 4: Verification
        document.getElementById('back-to-seed').addEventListener('click', () => {
            this.previousStep();
        });

        document.getElementById('complete-verification').addEventListener('click', () => {
            this.completeVerification();
        });

        // Step 5: Success
        document.getElementById('open-wallet').addEventListener('click', () => {
            this.openWallet();
        });
    }

    showStep(stepName) {
        // Hide all steps
        document.querySelectorAll('.setup-step').forEach(step => {
            step.classList.remove('active');
        });

        // Show current step
        const currentStepElement = document.getElementById(`step-${stepName}`);
        if (currentStepElement) {
            currentStepElement.classList.add('active');
        }

        // Update progress
        const stepIndex = this.steps.indexOf(stepName);
        this.updateProgress(stepIndex);

        // Handle specific step logic
        switch (stepName) {
            case 'seed-display':
                this.generateSeedPhrase();
                break;
            case 'seed-import':
                this.showImportStep();
                break;
            case 'verification':
                this.setupVerification();
                break;
            case 'success':
                this.showSuccess();
                break;
        }
    }

    updateProgress(stepIndex) {
        const progressFill = document.getElementById('progress-fill');
        const stepIndicator = document.getElementById('step-indicator');
        
        let progress = 0;
        let stepText = '';

        switch (stepIndex) {
            case 0: // welcome
                progress = 25;
                stepText = 'Step 1 of 4';
                break;
            case 1: // password
                progress = 50;
                stepText = 'Step 2 of 4';
                break;
            case 2: // seed-display/import
                progress = 75;
                stepText = 'Step 3 of 4';
                break;
            case 3: // verification
                progress = 90;
                stepText = 'Step 4 of 4';
                break;
            case 4: // success
                progress = 100;
                stepText = 'Complete!';
                break;
        }

        progressFill.style.width = `${progress}%`;
        stepIndicator.textContent = stepText;
    }

    nextStep() {
        if (this.currentStep < this.steps.length - 1) {
            this.currentStep++;
            let stepName = this.steps[this.currentStep];
            
            // Handle special case for import vs create
            if (stepName === 'seed-display' && this.setupType === 'import') {
                stepName = 'seed-import';
            }
            
            this.showStep(stepName);
        }
    }

    previousStep() {
        if (this.currentStep > 0) {
            this.currentStep--;
            let stepName = this.steps[this.currentStep];
            
            // Handle special case for import vs create
            if (stepName === 'seed-display' && this.setupType === 'import') {
                stepName = 'seed-import';
            }
            
            this.showStep(stepName);
        }
    }

    validatePassword() {
        const password = document.getElementById('new-password').value;
        const confirmPassword = document.getElementById('confirm-password').value;
        const continueBtn = document.getElementById('continue-password');
        const errorDiv = document.getElementById('password-error');

        // Password requirements
        const requirements = {
            length: password.length >= 8,
            lowercase: /[a-z]/.test(password),
            uppercase: /[A-Z]/.test(password),
            number: /[0-9]/.test(password),
            special: /[!@#$%^&*(),.?":{}|<>]/.test(password)
        };

        // Update requirement indicators
        Object.keys(requirements).forEach(req => {
            const element = document.getElementById(`check-${req}`);
            if (element) {
                element.classList.toggle('valid', requirements[req]);
            }
        });

        // Check if all requirements are met
        const allRequirementsMet = Object.values(requirements).every(req => req);
        const passwordsMatch = password === confirmPassword && password.length > 0;

        // Show/hide errors
        if (confirmPassword && !passwordsMatch) {
            this.showError(errorDiv, 'Passwords do not match');
        } else if (password && !allRequirementsMet) {
            this.showError(errorDiv, 'Password does not meet all requirements');
        } else {
            this.hideError(errorDiv);
        }

        // Enable/disable continue button
        continueBtn.disabled = !(allRequirementsMet && passwordsMatch);
    }

    async handlePasswordSubmit() {
        const password = document.getElementById('new-password').value;
        const confirmPassword = document.getElementById('confirm-password').value;

        if (password !== confirmPassword) {
            this.showError(document.getElementById('password-error'), 'Passwords do not match');
            return;
        }

        this.password = password;
        this.nextStep();
    }

    async generateSeedPhrase() {
        try {
            // Generate new mnemonic
            this.mnemonic = await SecureCrypto.generateMnemonic();
            const words = this.mnemonic.split(' ');

            // Display seed phrase
            const grid = document.getElementById('seed-phrase-grid');
            grid.innerHTML = '';

            words.forEach((word, index) => {
                const wordElement = document.createElement('div');
                wordElement.className = 'seed-word';
                wordElement.style.animationDelay = `${index * 0.05}s`;
                
                wordElement.innerHTML = `
                    <span class="word-number">${index + 1}</span>
                    <span class="word-text">${word}</span>
                `;
                
                grid.appendChild(wordElement);
            });

        } catch (error) {
            console.error('Error generating seed phrase:', error);
            this.showError(
                document.getElementById('password-error'), 
                'Error generating seed phrase. Please try again.'
            );
        }
    }

    showImportStep() {
        this.showStep('seed-import');
    }

    async validateImportPhrase() {
        const textarea = document.getElementById('seed-phrase-input');
        const phrase = textarea.value.trim().toLowerCase();
        const words = phrase.split(/\s+/).filter(word => word.length > 0);
        
        const wordCountCheck = document.getElementById('word-count-check');
        const wordsValidCheck = document.getElementById('words-valid-check');
        const continueBtn = document.getElementById('continue-import');

        // Check word count
        const validWordCount = words.length === 12 || words.length === 24;
        this.updateValidationItem(wordCountCheck, validWordCount);

        // Check if words are valid BIP39 words
        let wordsValid = false;
        if (validWordCount && words.length > 0) {
            try {
                wordsValid = await SecureCrypto.validateMnemonic(phrase);
            } catch (error) {
                wordsValid = false;
            }
        }
        this.updateValidationItem(wordsValidCheck, wordsValid);

        // Enable/disable continue button
        continueBtn.disabled = !(validWordCount && wordsValid);

        if (validWordCount && wordsValid) {
            this.mnemonic = phrase;
        }
    }

    updateValidationItem(element, isValid) {
        const icon = element.querySelector('.check-icon');
        
        element.classList.remove('valid', 'invalid', 'pending');
        
        if (isValid) {
            element.classList.add('valid');
            icon.textContent = '✓';
        } else {
            element.classList.add('invalid');
            icon.textContent = '✗';
        }
    }

    async handleImportSubmit() {
        const phrase = document.getElementById('seed-phrase-input').value.trim().toLowerCase();
        
        try {
            if (!(await SecureCrypto.validateMnemonic(phrase))) {
                throw new Error('Invalid recovery phrase');
            }
            
            this.mnemonic = phrase;
            this.nextStep(); // Skip verification for import
            this.nextStep(); // Go directly to success
            
        } catch (error) {
            this.showError(
                document.getElementById('import-error'),
                'Invalid recovery phrase. Please check your words and try again.'
            );
        }
    }

    setupVerification() {
        if (!this.mnemonic) return;

        const words = this.mnemonic.split(' ');
        const container = document.getElementById('verification-container');
        container.innerHTML = '';

        // Select 3 random words to verify
        const wordIndices = [];
        while (wordIndices.length < 3) {
            const randomIndex = Math.floor(Math.random() * words.length);
            if (!wordIndices.includes(randomIndex)) {
                wordIndices.push(randomIndex);
            }
        }
        
        wordIndices.sort((a, b) => a - b);
        this.verificationWords = wordIndices;
        this.verificationAnswers = {};

        wordIndices.forEach(wordIndex => {
            const fieldDiv = document.createElement('div');
            fieldDiv.className = 'verification-field';

            const label = document.createElement('label');
            label.textContent = `Word #${wordIndex + 1}`;
            
            const optionsDiv = document.createElement('div');
            optionsDiv.className = 'word-options';

            // Create 4 options: correct word + 3 random words
            const correctWord = words[wordIndex];
            const options = [correctWord];
            
            // Add 3 random words that aren't the correct word
            while (options.length < 4) {
                const randomWord = words[Math.floor(Math.random() * words.length)];
                if (!options.includes(randomWord)) {
                    options.push(randomWord);
                }
            }
            
            // Shuffle options
            options.sort(() => Math.random() - 0.5);

            options.forEach(word => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'word-option';
                button.textContent = word;
                button.dataset.wordIndex = wordIndex;
                button.dataset.word = word;
                
                button.addEventListener('click', () => {
                    this.selectVerificationWord(wordIndex, word, button);
                });
                
                optionsDiv.appendChild(button);
            });

            fieldDiv.appendChild(label);
            fieldDiv.appendChild(optionsDiv);
            container.appendChild(fieldDiv);
        });
    }

    selectVerificationWord(wordIndex, selectedWord, buttonElement) {
        // Remove selection from other buttons in the same group
        const allButtons = document.querySelectorAll(`[data-word-index="${wordIndex}"]`);
        allButtons.forEach(btn => btn.classList.remove('selected'));
        
        // Select this button
        buttonElement.classList.add('selected');
        this.verificationAnswers[wordIndex] = selectedWord;

        // Check if all words are selected
        const allSelected = this.verificationWords.every(index => 
            this.verificationAnswers.hasOwnProperty(index)
        );
        
        document.getElementById('complete-verification').disabled = !allSelected;
    }

    async completeVerification() {
        const words = this.mnemonic.split(' ');
        const errorDiv = document.getElementById('verification-error');
        
        // Check if all answers are correct
        const allCorrect = this.verificationWords.every(wordIndex => {
            return this.verificationAnswers[wordIndex] === words[wordIndex];
        });

        if (!allCorrect) {
            this.showError(errorDiv, 'Incorrect words selected. Please try again.');
            return;
        }

        // Create wallet
        await this.createWallet();
    }

    async createWallet() {
        try {
            // Create wallet using WalletManager
            const walletManager = new WalletManager();
            
            // Create encrypted wallet
            this.walletData = await walletManager.createWallet(this.password, this.mnemonic);
            
            this.nextStep(); // Go to success
            
        } catch (error) {
            console.error('Error creating wallet:', error);
            this.showError(
                document.getElementById('verification-error'),
                'Error creating wallet. Please try again.'
            );
        }
    }

    showSuccess() {
        if (this.walletData) {
            document.getElementById('qnet-address').textContent = this.walletData.qnetAddress;
            document.getElementById('solana-address').textContent = this.walletData.solanaAddress;
        }
    }

    async copySeedPhrase() {
        try {
            await navigator.clipboard.writeText(this.mnemonic);
            this.showToast('Recovery phrase copied to clipboard');
        } catch (error) {
            console.error('Failed to copy:', error);
            this.showToast('Failed to copy to clipboard', 'error');
        }
    }

    downloadSeedPhrase() {
        const blob = new Blob([this.mnemonic], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'qnet-wallet-recovery-phrase.txt';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        this.showToast('Recovery phrase downloaded');
    }

    async openWallet() {
        try {
            // Close setup window and open main wallet
            await chrome.runtime.sendMessage({ action: 'closeWalletSetup' });
            await chrome.runtime.sendMessage({ action: 'openPage', page: 'popup.html' });
        } catch (error) {
            console.error('Error opening wallet:', error);
            // Fallback: just close the setup window
            window.close();
        }
    }

    async closeSetup() {
        try {
            await chrome.runtime.sendMessage({ action: 'closeWalletSetup' });
        } catch (error) {
            console.error('Error closing setup:', error);
        }
        window.close();
    }

    showError(errorElement, message) {
        errorElement.textContent = message;
        errorElement.classList.add('show');
    }

    hideError(errorElement) {
        errorElement.classList.remove('show');
    }

    showToast(message, type = 'success') {
        // Create toast notification
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;
        
        toast.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: ${type === 'error' ? '#ef4444' : '#22c55e'};
            color: white;
            padding: 12px 20px;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 500;
            z-index: 10000;
            animation: slideInRight 0.3s ease-out;
        `;

        document.body.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'slideOutRight 0.3s ease-out';
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
            }, 300);
        }, 3000);
    }
}

// Add CSS for toast animations
const style = document.createElement('style');
style.textContent = `
    @keyframes slideInRight {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
    }
    
    @keyframes slideOutRight {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(100%); opacity: 0; }
    }
`;
document.head.appendChild(style);

// Initialize setup when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new WalletSetup();
});

// Handle window close
window.addEventListener('beforeunload', () => {
    chrome.runtime.sendMessage({ action: 'closeWalletSetup' }).catch(() => {
        // Ignore errors on close
    });
}); 