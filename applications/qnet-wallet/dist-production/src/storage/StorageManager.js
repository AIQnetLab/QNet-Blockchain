// QNet Storage Manager

export class StorageManager {
    constructor() {
        this.storage = chrome.storage.local;
    }
    
    // Save encrypted vault
    async saveVault(encryptedVault) {
        return new Promise((resolve, reject) => {
            this.storage.set({ encryptedVault }, () => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                } else {
                    resolve();
                }
            });
        });
    }
    
    // Get encrypted vault
    async getVault() {
        return new Promise((resolve) => {
            this.storage.get(['encryptedVault'], (result) => {
                resolve(result.encryptedVault || null);
            });
        });
    }
    

    
    // Save connected sites
    async saveConnectedSites(sites) {
        return new Promise((resolve, reject) => {
            this.storage.set({ connectedSites: sites }, () => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                } else {
                    resolve();
                }
            });
        });
    }
    
    // Get connected sites
    async getConnectedSites() {
        return new Promise((resolve) => {
            this.storage.get(['connectedSites'], (result) => {
                resolve(result.connectedSites || []);
            });
        });
    }
    
    // Add connected site
    async addConnectedSite(origin, permissions) {
        const sites = await this.getConnectedSites();
        const existingSite = sites.find(site => site.origin === origin);
        
        if (existingSite) {
            // Update permissions
            existingSite.permissions = [...new Set([...existingSite.permissions, ...permissions])];
            existingSite.lastConnected = Date.now();
        } else {
            // Add new site
            sites.push({
                origin,
                permissions,
                connectedAt: Date.now(),
                lastConnected: Date.now()
            });
        }
        
        await this.saveConnectedSites(sites);
    }
    
    // Remove connected site
    async removeConnectedSite(origin) {
        const sites = await this.getConnectedSites();
        const filtered = sites.filter(site => site.origin !== origin);
        await this.saveConnectedSites(filtered);
    }
    
    // Save node configuration
    async saveNodeConfig(nodeConfig) {
        return new Promise((resolve, reject) => {
            this.storage.set({ nodeConfig }, () => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                } else {
                    resolve();
                }
            });
        });
    }
    
    // Get node configuration
    async getNodeConfig() {
        return new Promise((resolve) => {
            this.storage.get(['nodeConfig'], (result) => {
                resolve(result.nodeConfig || null);
            });
        });
    }
    
    // Save transaction history
    async saveTransactions(address, transactions) {
        const key = `tx_${address}`;
        return new Promise((resolve, reject) => {
            this.storage.set({ [key]: transactions }, () => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                } else {
                    resolve();
                }
            });
        });
    }
    
    // Get transaction history
    async getTransactions(address) {
        const key = `tx_${address}`;
        return new Promise((resolve) => {
            this.storage.get([key], (result) => {
                resolve(result[key] || []);
            });
        });
    }
    
    // Save cached balance
    async saveBalance(address, balance) {
        const key = `balance_${address}`;
        const data = {
            balance,
            timestamp: Date.now()
        };
        
        return new Promise((resolve, reject) => {
            this.storage.set({ [key]: data }, () => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                } else {
                    resolve();
                }
            });
        });
    }
    
    // Get cached balance
    async getBalance(address) {
        const key = `balance_${address}`;
        return new Promise((resolve) => {
            this.storage.get([key], (result) => {
                const data = result[key];
                // Return null if cache is older than 1 minute
                if (data && Date.now() - data.timestamp < 60000) {
                    resolve(data.balance);
                } else {
                    resolve(null);
                }
            });
        });
    }
    
    // Save settings
    async saveSettings(settings) {
        return new Promise((resolve, reject) => {
            this.storage.set({ settings }, () => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                } else {
                    resolve();
                }
            });
        });
    }
    
    // Get settings
    async getSettings() {
        return new Promise((resolve) => {
            this.storage.get(['settings'], (result) => {
                resolve(result.settings || {
                    autoLockTime: 15, // minutes
                    currency: 'USD',
                    notifications: true,
                    theme: 'dark'
                });
            });
        });
    }
    
    // Clear all data
    async clearAll() {
        return new Promise((resolve, reject) => {
            this.storage.clear(() => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                } else {
                    resolve();
                }
            });
        });
    }
    
    // Export wallet data (for backup)
    async exportWalletData() {
        return new Promise((resolve) => {
            this.storage.get(null, (items) => {
                // Remove sensitive data
                resolve(items);
            });
        });
    }
    
    // Import wallet data (from backup)
    async importWalletData(data) {
        return new Promise((resolve, reject) => {
            this.storage.set(data, () => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                } else {
                    resolve();
                }
            });
        });
    }
} 