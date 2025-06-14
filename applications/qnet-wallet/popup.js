// QNet Wallet Popup Script with Full Internationalization
import { t, changeLanguage, getCurrentLanguage, formatCurrency, formatDate, onLanguageChange } from './src/i18n/index.js';
import WalletManager from './src/wallet/WalletManager.js';

class QNetWalletPopup {
  constructor() {
    this.walletManager = new WalletManager();
    this.currentScreen = 'loading';
    this.currentTab = 'overview';
    this.isInitialized = false;
    
    this.init();
  }

  async init() {
    try {
      // Initialize internationalization
      await this.initializeI18n();
      
      // Check wallet status
      await this.checkWalletStatus();
      
      // Setup event listeners
      this.setupEventListeners();
      
      // Setup language change listener
      onLanguageChange(() => {
        this.updateAllTranslations();
      });
      
      this.isInitialized = true;
      
      // Hide loading screen
      setTimeout(() => {
        this.hideScreen('loading-screen');
      }, 1000);
      
    } catch (error) {
      console.error('Failed to initialize wallet popup:', error);
      this.showError('Failed to initialize wallet');
    }
  }

  async initializeI18n() {
    // Load saved language preference
    const result = await chrome.storage.local.get(['language']);
    if (result.language) {
      await changeLanguage(result.language);
    }
    
    // Update all translations
    this.updateAllTranslations();
  }

  updateAllTranslations() {
    // Update all elements with data-i18n attribute
    document.querySelectorAll('[data-i18n]').forEach(element => {
      const key = element.getAttribute('data-i18n');
      element.textContent = t(key);
    });
    
    // Update placeholders
    document.querySelectorAll('[data-i18n-placeholder]').forEach(element => {
      const key = element.getAttribute('data-i18n-placeholder');
      element.placeholder = t(key);
    });
    
    // Update language selectors
    const currentLang = getCurrentLanguage();
    document.querySelectorAll('#language-select, #settings-language').forEach(select => {
      select.value = currentLang;
    });
  }

  async checkWalletStatus() {
    try {
      const result = await chrome.storage.local.get(['encryptedVault']);
      
      if (!result.encryptedVault) {
        // No wallet exists, show welcome screen
        this.showScreen('welcome-screen');
      } else {
        // Wallet exists, show unlock screen
        this.showScreen('unlock-screen');
      }
    } catch (error) {
      console.error('Failed to check wallet status:', error);
      this.showScreen('welcome-screen');
    }
  }

  setupEventListeners() {
    // Language selection
    document.getElementById('language-select')?.addEventListener('change', (e) => {
      this.changeLanguage(e.target.value);
    });
    
    document.getElementById('settings-language')?.addEventListener('change', (e) => {
      this.changeLanguage(e.target.value);
    });

    // Welcome screen buttons
    document.getElementById('create-wallet-btn')?.addEventListener('click', () => {
      this.openFullPage('create-wallet.html');
    });
    
    document.getElementById('import-wallet-btn')?.addEventListener('click', () => {
      this.openFullPage('import-wallet.html');
    });

    // Unlock form
    document.getElementById('unlock-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.unlockWallet();
    });

    // Wallet header actions
    document.getElementById('settings-btn')?.addEventListener('click', () => {
      this.showModal('settings-modal');
    });
    
    document.getElementById('lock-btn')?.addEventListener('click', () => {
      this.lockWallet();
    });

    // Tab navigation
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tab = e.target.getAttribute('data-tab');
        this.switchTab(tab);
      });
    });

    // Quick actions
    document.querySelectorAll('.action-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const action = e.target.closest('.action-btn').getAttribute('data-action');
        this.handleQuickAction(action);
      });
    });

    // Send form
    document.getElementById('send-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleSendTransaction();
    });

    // Max amount button
    document.getElementById('max-amount-btn')?.addEventListener('click', () => {
      this.setMaxAmount();
    });

    // Copy address button
    document.getElementById('copy-address-btn')?.addEventListener('click', () => {
      this.copyAddress();
    });

    // Node activation
    document.getElementById('activate-node-btn')?.addEventListener('click', () => {
      this.activateNode();
    });

    // One-click node activation
    document.getElementById('activate-node-one-click-btn')?.addEventListener('click', () => {
      this.activateNodeOneClick();
    });

    // Modal close buttons
    document.querySelectorAll('.modal-close').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const modal = e.target.closest('.modal');
        this.hideModal(modal.id);
      });
    });

    // Transaction confirmation
    document.getElementById('confirm-tx-btn')?.addEventListener('click', () => {
      this.confirmTransaction();
    });
    
    document.getElementById('cancel-tx-btn')?.addEventListener('click', () => {
      this.hideModal('tx-confirm-modal');
    });

    // Amount input validation
    document.getElementById('send-amount')?.addEventListener('input', (e) => {
      this.updateTransactionSummary();
    });
  }

  async changeLanguage(language) {
    try {
      await changeLanguage(language);
      await chrome.storage.local.set({ language });
      this.updateAllTranslations();
    } catch (error) {
      console.error('Failed to change language:', error);
    }
  }

  async unlockWallet() {
    const password = document.getElementById('unlock-password').value;
    const errorElement = document.getElementById('unlock-error');
    
    if (!password) {
      this.showError(t('wallet.enterPassword'), errorElement);
      return;
    }

    try {
      const unlocked = await this.walletManager.unlock(password);
      
      if (unlocked) {
        this.showScreen('wallet-screen');
        await this.loadWalletData();
      } else {
        this.showError(t('wallet.invalidPassword'), errorElement);
      }
    } catch (error) {
      console.error('Failed to unlock wallet:', error);
      this.showError(t('errors.unknownError'), errorElement);
    }
  }

  async lockWallet() {
    try {
      await this.walletManager.lock();
      this.showScreen('unlock-screen');
      this.clearWalletData();
    } catch (error) {
      console.error('Failed to lock wallet:', error);
    }
  }

  async loadWalletData() {
    try {
      if (this.walletManager.isLocked) return;

      // Load balance
      const balance = await this.walletManager.getBalance();
      this.updateBalance(balance);

      // Load filtered balances (1DEV + QNC only)
      await this.loadFilteredBalances();

      // Load address
      const address = this.walletManager.wallet.address;
      this.updateAddress(address);

      // Load transaction history
      const transactions = await this.walletManager.getTransactionHistory();
      this.updateTransactionList(transactions);

      // Load node status
      await this.loadNodeStatus();

    } catch (error) {
      console.error('Failed to load wallet data:', error);
    }
  }

  updateBalance(balance) {
    const balanceAmount = document.getElementById('balance-amount');
    const balanceQnc = document.getElementById('balance-qnc');
    const balanceUsd = document.getElementById('balance-usd');

    if (balanceAmount) balanceAmount.textContent = balance.total.toFixed(8);
    if (balanceQnc) balanceQnc.textContent = formatCurrency(balance.qnc, 'QNC');
    if (balanceUsd) balanceUsd.textContent = `$${(balance.total * 0.1).toFixed(2)} USD`; // Mock USD price
  }

  updateAddress(address) {
    const addressElements = document.querySelectorAll('#wallet-address, #receive-address');
    const shortAddress = `${address.slice(0, 6)}...${address.slice(-4)}`;
    
    addressElements.forEach(element => {
      if (element.tagName === 'INPUT') {
        element.value = address;
      } else {
        element.textContent = shortAddress;
      }
    });

    // Generate QR code
    this.generateQRCode(address);
  }

  generateQRCode(address) {
    const qrContainer = document.getElementById('qr-code');
    if (qrContainer && window.QRCode) {
      qrContainer.innerHTML = '';
      new QRCode(qrContainer, {
        text: address,
        width: 200,
        height: 200,
        colorDark: '#000000',
        colorLight: '#ffffff'
      });
    }
  }

  updateTransactionList(transactions) {
    const listContainer = document.getElementById('transaction-list');
    if (!listContainer) return;

    if (transactions.length === 0) {
      listContainer.innerHTML = `<div class="no-transactions">${t('transactions.noTransactions')}</div>`;
      return;
    }

    listContainer.innerHTML = transactions.map(tx => `
      <div class="transaction-item">
        <div class="tx-info">
          <div class="tx-type">${tx.type === 'send' ? '📤' : '📥'} ${tx.type}</div>
          <div class="tx-address">${tx.address}</div>
        </div>
        <div class="tx-details">
          <div class="tx-amount">${formatCurrency(tx.amount, 'QNC')}</div>
          <div class="tx-date">${formatDate(tx.timestamp)}</div>
        </div>
      </div>
    `).join('');
  }

  async loadNodeStatus() {
    // Mock node status - replace with actual API calls
    const nodeStatus = document.getElementById('node-status');
    if (nodeStatus) {
      const statusIndicator = nodeStatus.querySelector('.status-indicator');
      statusIndicator.className = 'status-indicator inactive';
      statusIndicator.querySelector('span:last-child').textContent = t('node.nodeStatus') + ': Inactive';
    }
  }

  switchTab(tabName) {
    // Update tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.remove('active');
    });
    document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');

    // Update tab content
    document.querySelectorAll('.tab-content').forEach(content => {
      content.classList.remove('active');
    });
    document.getElementById(`${tabName}-tab`).classList.add('active');

    this.currentTab = tabName;
  }

  handleQuickAction(action) {
    switch (action) {
      case 'send':
        this.switchTab('send');
        break;
      case 'receive':
        this.switchTab('receive');
        break;
      case 'node':
        this.switchTab('node');
        break;
    }
  }

  async handleSendTransaction() {
    const address = document.getElementById('send-address').value;
    const amount = parseFloat(document.getElementById('send-amount').value);
    const memo = document.getElementById('send-memo').value;

    if (!address || !amount) {
      this.showError(t('errors.invalidInput'));
      return;
    }

    // Show confirmation modal
    this.showTransactionConfirmation(address, amount, memo);
  }

  showTransactionConfirmation(address, amount, memo) {
    const fee = 0.001; // QNet transaction fee
    const total = amount + fee;

    document.getElementById('confirm-recipient').textContent = address;
    document.getElementById('confirm-amount').textContent = formatCurrency(amount, 'QNC');
    document.getElementById('confirm-fee').textContent = formatCurrency(fee, 'QNC');
    document.getElementById('confirm-total').textContent = formatCurrency(total, 'QNC');

    this.showModal('tx-confirm-modal');
  }

  async confirmTransaction() {
    try {
      const address = document.getElementById('confirm-recipient').textContent;
      const amount = parseFloat(document.getElementById('confirm-amount').textContent);
      const memo = document.getElementById('send-memo').value;

      const result = await this.walletManager.sendTransaction(address, amount, memo);
      
      if (result.success) {
        this.showSuccess(t('transactions.transactionSent'));
        this.hideModal('tx-confirm-modal');
        this.clearSendForm();
        await this.loadWalletData();
      }
    } catch (error) {
      console.error('Transaction failed:', error);
      this.showError(t('transactions.transactionFailed'));
    }
  }

  async activateNode() {
    try {
      const nodeType = document.querySelector('input[name="nodeType"]:checked').value;
      
      const result = await this.walletManager.activateNode(nodeType, 1500);
      
      if (result.success) {
        this.showSuccess(t('node.nodeActivated'));
        await this.loadNodeStatus();
        await this.loadWalletData();
      }
    } catch (error) {
      console.error('Node activation failed:', error);
      this.showError(t('node.activationFailed'));
    }
  }

  async activateNodeOneClick() {
    try {
      // Get selected node type
      const nodeTypeElement = document.querySelector('input[name="nodeTypePhase1"]:checked');
      if (!nodeTypeElement) {
        this.showError('Please select a node type');
        return;
      }
      
      const nodeType = nodeTypeElement.value;
      
      // Show progress interface
      this.showActivationProgress();
      
      // Step 1: Check 1DEV balance
      this.updateProgressStep('step-burn', 'active');
      const balance = await this.walletManager.get1DEVBalance();
      const required = this.walletManager.getRequiredBurnAmount(nodeType);
      
      if (balance < required) {
        throw new Error(`Insufficient 1DEV balance. Have: ${balance}, Need: ${required}`);
      }
      
      // Step 2: Execute one-click activation
      this.updateProgressStep('step-verify', 'active');
      this.updateProgress(25);
      
      const result = await this.walletManager.activateNodeOneClick(nodeType);
      
      this.updateProgressStep('step-setup', 'active');
      this.updateProgress(75);
      
      // Step 3: Complete
      this.updateProgressStep('step-complete', 'active');
      this.updateProgress(100);
      
      if (result.success) {
        this.showSuccess(`✅ Node activated! ID: ${result.nodeId}`);
        await this.loadNodeStatus();
        await this.loadWalletData();
      }
      
    } catch (error) {
      console.error('One-click activation failed:', error);
      this.showError(`❌ Activation failed: ${error.message}`);
      this.hideActivationProgress();
    }
  }

  showActivationProgress() {
    const progressDiv = document.getElementById('activation-progress');
    const activateBtn = document.getElementById('activate-node-one-click-btn');
    
    if (progressDiv) progressDiv.classList.remove('hidden');
    if (activateBtn) activateBtn.style.display = 'none';
    
    // Reset all steps
    const steps = document.querySelectorAll('.step');
    steps.forEach(step => {
      step.classList.remove('active', 'completed');
    });
    
    this.updateProgress(0);
  }

  hideActivationProgress() {
    const progressDiv = document.getElementById('activation-progress');
    const activateBtn = document.getElementById('activate-node-one-click-btn');
    
    if (progressDiv) progressDiv.classList.add('hidden');
    if (activateBtn) activateBtn.style.display = 'block';
  }

  updateProgressStep(stepId, status) {
    const step = document.getElementById(stepId);
    if (step) {
      step.classList.remove('active', 'completed');
      step.classList.add(status);
    }
  }

  updateProgress(percentage) {
    const progressFill = document.getElementById('progress-fill');
    if (progressFill) {
      progressFill.style.width = `${percentage}%`;
    }
  }

  async loadFilteredBalances() {
    try {
      // Load only filtered balances (1DEV + QNC)
      const balances = await this.walletManager.getFilteredBalances();
      
      // Update 1DEV balance display
      const devBalanceElement = document.getElementById('1dev-balance');
      if (devBalanceElement && balances['1DEV'] !== undefined) {
        devBalanceElement.textContent = `${balances['1DEV']} 1DEV`;
      }
      
      // Update QNC balance display
      const qncBalanceElement = document.getElementById('balance-qnc');
      if (qncBalanceElement && balances['QNC'] !== undefined) {
        qncBalanceElement.textContent = `${balances['QNC']} QNC`;
      }
      
      console.log('✅ Filtered balances loaded:', balances);
    } catch (error) {
      console.error('Failed to load filtered balances:', error);
    }
  }

  async setMaxAmount() {
    try {
      const balance = await this.walletManager.getBalance();
      const fee = 0.001;
      const maxAmount = Math.max(0, balance.total - fee);
      
      document.getElementById('send-amount').value = maxAmount.toFixed(8);
      this.updateTransactionSummary();
    } catch (error) {
      console.error('Failed to set max amount:', error);
    }
  }

  updateTransactionSummary() {
    const amount = parseFloat(document.getElementById('send-amount').value) || 0;
    const fee = 0.001;
    const total = amount + fee;

    document.getElementById('network-fee').textContent = formatCurrency(fee, 'QNC');
    document.getElementById('total-amount').textContent = formatCurrency(total, 'QNC');
  }

  async copyAddress() {
    try {
      const address = document.getElementById('receive-address').value;
      await navigator.clipboard.writeText(address);
      this.showSuccess(t('common.copied'));
    } catch (error) {
      console.error('Failed to copy address:', error);
    }
  }

  clearSendForm() {
    document.getElementById('send-address').value = '';
    document.getElementById('send-amount').value = '';
    document.getElementById('send-memo').value = '';
    this.updateTransactionSummary();
  }

  clearWalletData() {
    document.getElementById('balance-amount').textContent = '0.00';
    document.getElementById('balance-qnc').textContent = '0.00 QNC';
    document.getElementById('balance-usd').textContent = '$0.00 USD';
    document.getElementById('wallet-address').textContent = 'Loading...';
  }

  showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(screen => {
      screen.classList.add('hidden');
    });
    document.getElementById(screenId).classList.remove('hidden');
    this.currentScreen = screenId;
  }

  hideScreen(screenId) {
    document.getElementById(screenId).classList.add('hidden');
  }

  showModal(modalId) {
    document.getElementById(modalId).classList.remove('hidden');
  }

  hideModal(modalId) {
    document.getElementById(modalId).classList.add('hidden');
  }

  showError(message, element = null) {
    if (element) {
      element.textContent = message;
      element.classList.remove('hidden');
      setTimeout(() => element.classList.add('hidden'), 5000);
    } else {
      // Show global error notification
      console.error(message);
    }
  }

  showSuccess(message) {
    // Show success notification
    console.log(message);
  }

  openFullPage(page) {
    chrome.runtime.sendMessage({
      action: 'openPage',
      page: page
    });
    window.close();
  }
}

// Initialize wallet popup when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  new QNetWalletPopup();
}); 