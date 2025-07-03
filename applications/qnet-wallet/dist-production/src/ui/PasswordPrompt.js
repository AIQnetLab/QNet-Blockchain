// QNet Password Prompt UI Component

export class PasswordPrompt {
    constructor() {
        this.callbacks = new Map();
        this.currentPromptId = null;
    }
    
    // Request password from user
    async requestPassword(reason = 'Authentication required') {
        return new Promise((resolve, reject) => {
            const promptId = this.generatePromptId();
            this.currentPromptId = promptId;
            
            // Store callback
            this.callbacks.set(promptId, { resolve, reject });
            
            // Create and show prompt
            this.showPrompt(promptId, reason);
            
            // Set timeout
            setTimeout(() => {
                if (this.callbacks.has(promptId)) {
                    this.callbacks.get(promptId).reject(new Error('Password prompt timeout'));
                    this.callbacks.delete(promptId);
                    this.hidePrompt();
                }
            }, 60000); // 1 minute timeout
        });
    }
    
    // Show password prompt UI
    showPrompt(promptId, reason) {
        // Remove any existing prompt
        this.hidePrompt();
        
        // Create prompt HTML
        const promptHtml = `
            <div id="qnet-password-prompt" class="qnet-prompt-overlay">
                <div class="qnet-prompt-modal">
                    <div class="qnet-prompt-header">
                        <h3>Password Required</h3>
                        <button class="qnet-prompt-close" id="qnet-prompt-close">&times;</button>
                    </div>
                    <div class="qnet-prompt-body">
                        <p class="qnet-prompt-reason">${this.escapeHtml(reason)}</p>
                        <div class="qnet-prompt-input-group">
                            <label for="qnet-password-input">Enter your wallet password:</label>
                            <input 
                                type="password" 
                                id="qnet-password-input" 
                                class="qnet-prompt-input"
                                placeholder="Password"
                                autocomplete="off"
                            />
                        </div>
                        <div class="qnet-prompt-error" id="qnet-prompt-error"></div>
                    </div>
                    <div class="qnet-prompt-footer">
                        <button class="qnet-prompt-btn qnet-prompt-btn-cancel" id="qnet-prompt-cancel">
                            Cancel
                        </button>
                        <button class="qnet-prompt-btn qnet-prompt-btn-submit" id="qnet-prompt-submit">
                            Unlock
                        </button>
                    </div>
                </div>
            </div>
        `;
        
        // Add styles
        this.injectStyles();
        
        // Add to DOM
        const container = document.createElement('div');
        container.innerHTML = promptHtml;
        document.body.appendChild(container.firstElementChild);
        
        // Setup event listeners
        this.setupEventListeners(promptId);
        
        // Focus password input
        setTimeout(() => {
            document.getElementById('qnet-password-input')?.focus();
        }, 100);
    }
    
    // Hide prompt
    hidePrompt() {
        const prompt = document.getElementById('qnet-password-prompt');
        if (prompt) {
            prompt.remove();
        }
        this.currentPromptId = null;
    }
    
    // Setup event listeners
    setupEventListeners(promptId) {
        // Close button
        document.getElementById('qnet-prompt-close')?.addEventListener('click', () => {
            this.handleCancel(promptId);
        });
        
        // Cancel button
        document.getElementById('qnet-prompt-cancel')?.addEventListener('click', () => {
            this.handleCancel(promptId);
        });
        
        // Submit button
        document.getElementById('qnet-prompt-submit')?.addEventListener('click', () => {
            this.handleSubmit(promptId);
        });
        
        // Enter key in password input
        document.getElementById('qnet-password-input')?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.handleSubmit(promptId);
            }
        });
        
        // Escape key
        document.addEventListener('keydown', this.handleEscape = (e) => {
            if (e.key === 'Escape' && this.currentPromptId === promptId) {
                this.handleCancel(promptId);
            }
        });
    }
    
    // Handle submit
    handleSubmit(promptId) {
        const passwordInput = document.getElementById('qnet-password-input');
        const errorDiv = document.getElementById('qnet-prompt-error');
        
        if (!passwordInput) return;
        
        const password = passwordInput.value;
        
        // Validate password
        if (!password) {
            errorDiv.textContent = 'Please enter your password';
            passwordInput.focus();
            return;
        }
        
        if (password.length < 8) {
            errorDiv.textContent = 'Password must be at least 8 characters';
            passwordInput.focus();
            return;
        }
        
        // Clear password from input
        passwordInput.value = '';
        
        // Resolve promise
        const callback = this.callbacks.get(promptId);
        if (callback) {
            callback.resolve(password);
            this.callbacks.delete(promptId);
        }
        
        // Hide prompt
        this.hidePrompt();
        
        // Remove escape listener
        if (this.handleEscape) {
            document.removeEventListener('keydown', this.handleEscape);
        }
    }
    
    // Handle cancel
    handleCancel(promptId) {
        const callback = this.callbacks.get(promptId);
        if (callback) {
            callback.reject(new Error('User cancelled password prompt'));
            this.callbacks.delete(promptId);
        }
        
        this.hidePrompt();
        
        // Remove escape listener
        if (this.handleEscape) {
            document.removeEventListener('keydown', this.handleEscape);
        }
    }
    
    // Generate unique prompt ID
    generatePromptId() {
        return `prompt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    
    // Escape HTML
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    // Inject styles
    injectStyles() {
        if (document.getElementById('qnet-prompt-styles')) return;
        
        const styles = `
            .qnet-prompt-overlay {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.5);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 999999;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            }
            
            .qnet-prompt-modal {
                background: white;
                border-radius: 12px;
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
                width: 400px;
                max-width: 90%;
                overflow: hidden;
            }
            
            .qnet-prompt-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 20px;
                border-bottom: 1px solid #e5e7eb;
            }
            
            .qnet-prompt-header h3 {
                margin: 0;
                font-size: 18px;
                font-weight: 600;
                color: #111827;
            }
            
            .qnet-prompt-close {
                background: none;
                border: none;
                font-size: 24px;
                color: #6b7280;
                cursor: pointer;
                padding: 0;
                width: 32px;
                height: 32px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 6px;
                transition: all 0.2s;
            }
            
            .qnet-prompt-close:hover {
                background: #f3f4f6;
                color: #111827;
            }
            
            .qnet-prompt-body {
                padding: 20px;
            }
            
            .qnet-prompt-reason {
                margin: 0 0 20px 0;
                color: #6b7280;
                font-size: 14px;
            }
            
            .qnet-prompt-input-group {
                margin-bottom: 16px;
            }
            
            .qnet-prompt-input-group label {
                display: block;
                margin-bottom: 8px;
                font-size: 14px;
                font-weight: 500;
                color: #374151;
            }
            
            .qnet-prompt-input {
                width: 100%;
                padding: 10px 12px;
                border: 1px solid #d1d5db;
                border-radius: 8px;
                font-size: 14px;
                transition: all 0.2s;
                box-sizing: border-box;
            }
            
            .qnet-prompt-input:focus {
                outline: none;
                border-color: #3b82f6;
                box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
            }
            
            .qnet-prompt-error {
                color: #ef4444;
                font-size: 13px;
                margin-top: 8px;
                min-height: 20px;
            }
            
            .qnet-prompt-footer {
                display: flex;
                gap: 12px;
                padding: 20px;
                border-top: 1px solid #e5e7eb;
                background: #f9fafb;
            }
            
            .qnet-prompt-btn {
                flex: 1;
                padding: 10px 16px;
                border-radius: 8px;
                font-size: 14px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.2s;
                border: none;
            }
            
            .qnet-prompt-btn-cancel {
                background: white;
                color: #374151;
                border: 1px solid #d1d5db;
            }
            
            .qnet-prompt-btn-cancel:hover {
                background: #f3f4f6;
            }
            
            .qnet-prompt-btn-submit {
                background: #3b82f6;
                color: white;
            }
            
            .qnet-prompt-btn-submit:hover {
                background: #2563eb;
            }
            
            .qnet-prompt-btn:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
        `;
        
        const styleElement = document.createElement('style');
        styleElement.id = 'qnet-prompt-styles';
        styleElement.textContent = styles;
        document.head.appendChild(styleElement);
    }
}

// Export singleton instance
export const passwordPrompt = new PasswordPrompt(); 