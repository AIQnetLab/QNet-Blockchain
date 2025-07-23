/**
 * Production Solana RPC Integration
 * Real blockchain interaction with Solana network
 */

/**
 * Solana RPC Client for production wallet
 */
export class SolanaRPC {
    constructor(network = 'mainnet-beta') {
        this.networks = {
            'mainnet-beta': 'https://api.mainnet-beta.solana.com',
            'testnet': 'https://api.testnet.solana.com',
            'devnet': 'https://api.devnet.solana.com'
        };
        
        this.rpcUrl = this.networks[network] || this.networks['mainnet-beta'];
        this.currentNetwork = network;
        this.requestId = 0;
        
        // Cache for performance
        this.cache = new Map();
        this.cacheTimeout = 30000; // 30 seconds
    }
    
    /**
     * Make RPC request to Solana network
     */
    async makeRequest(method, params = []) {
        try {
            const requestId = ++this.requestId;
            
            const response = await fetch(this.rpcUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: requestId,
                    method: method,
                    params: params
                })
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const data = await response.json();
            
            if (data.error) {
                throw new Error(`RPC Error: ${data.error.message}`);
            }
            
            return data.result;
        } catch (error) {
            console.error(`Solana RPC ${method} failed:`, error);
            throw new Error(`Network request failed: ${error.message}`);
        }
    }
    
    /**
     * Get account balance in SOL
     */
    async getBalance(address) {
        try {
            // Check cache first
            const cacheKey = `balance-${address}`;
            const cached = this.getFromCache(cacheKey);
            if (cached !== null) return cached;
            
            // Real Solana devnet integration - no mocks for production
            const result = await this.makeRequest('getBalance', [address]);
            
            if (!result || typeof result.value !== 'number') {
                console.warn('Invalid balance response from Solana devnet:', result);
                return 0;
            }
            
            const balanceInLamports = result.value;
            const balanceInSOL = balanceInLamports / 1000000000; // Convert lamports to SOL
            
            // Cache result for 30 seconds
            this.setCache(cacheKey, balanceInSOL, 30000);
            
            console.log(`💰 Real Solana devnet balance for ${address}: ${balanceInSOL} SOL`);
            return balanceInSOL;
        } catch (error) {
            console.error('Failed to get balance from Solana devnet:', error);
            // For testnet, don't fallback to mock - return 0 for real integration
            return 0;
        }
    }
    
    /**
     * Get account info including token balances
     */
    async getAccountInfo(address) {
        try {
            const cacheKey = `account-${address}`;
            const cached = this.getFromCache(cacheKey);
            if (cached !== null) return cached;
            
            const result = await this.makeRequest('getAccountInfo', [
                address,
                { encoding: 'base64' }
            ]);
            
            this.setCache(cacheKey, result);
            return result;
        } catch (error) {
            console.error('Failed to get account info:', error);
            return null;
        }
    }
    
    /**
     * Get token accounts for address
     */
    async getTokenAccounts(address) {
        try {
            const cacheKey = `tokens-${address}`;
            const cached = this.getFromCache(cacheKey);
            if (cached !== null) return cached;
            
            const result = await this.makeRequest('getTokenAccountsByOwner', [
                address,
                { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
                { encoding: 'jsonParsed' }
            ]);
            
            const tokenBalances = result.value.map(account => {
                const info = account.account.data.parsed.info;
                return {
                    mint: info.mint,
                    balance: parseFloat(info.tokenAmount.uiAmount || 0),
                    decimals: info.tokenAmount.decimals,
                    address: account.pubkey
                };
            });
            
            this.setCache(cacheKey, tokenBalances);
            return tokenBalances;
        } catch (error) {
            console.error('Failed to get token accounts:', error);
            return [];
        }
    }
    
    /**
     * Get transaction history
     */
    async getTransactionHistory(address, limit = 10) {
        try {
            const signatures = await this.makeRequest('getSignaturesForAddress', [
                address,
                { limit: limit }
            ]);
            
            const transactions = [];
            for (const sig of signatures) {
                try {
                    const tx = await this.getTransaction(sig.signature);
                    if (tx) {
                        transactions.push({
                            signature: sig.signature,
                            slot: sig.slot,
                            blockTime: sig.blockTime,
                            status: sig.err ? 'failed' : 'success',
                            transaction: tx
                        });
                    }
                } catch (error) {
                    console.warn('Failed to fetch transaction:', sig.signature);
                }
            }
            
            return transactions;
        } catch (error) {
            console.error('Failed to get transaction history:', error);
            return [];
        }
    }
    
    /**
     * Get specific transaction details
     */
    async getTransaction(signature) {
        try {
            const result = await this.makeRequest('getTransaction', [
                signature,
                { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }
            ]);
            
            return result;
        } catch (error) {
            console.error('Failed to get transaction:', error);
            return null;
        }
    }
    
    /**
     * Send transaction to network
     */
    async sendTransaction(signedTransaction) {
        try {
            // Serialize transaction for real Solana devnet
            const serialized = signedTransaction.serialize();
            const base64Transaction = Buffer.from(serialized).toString('base64');
            
            // Send transaction to real Solana devnet
            const signature = await this.makeRequest('sendTransaction', [
                base64Transaction,
                { 
                    encoding: 'base64', 
                    skipPreflight: false, 
                    preflightCommitment: 'processed',
                    maxRetries: 3
                }
            ]);
            
            if (!signature || typeof signature !== 'string') {
                throw new Error('Invalid signature response from Solana devnet');
            }
            
            console.log('✅ Transaction sent to Solana devnet:', signature);
            
            // Wait for confirmation on real devnet
            const confirmation = await this.confirmTransaction(signature);
            
            return {
                signature: signature,
                confirmed: confirmation.confirmed,
                slot: confirmation.slot,
                network: 'solana-devnet'
            };
        } catch (error) {
            console.error('Failed to send transaction to Solana devnet:', error);
            throw error;
        }
    }
    
    /**
     * Confirm transaction
     */
    async confirmTransaction(signature, commitment = 'confirmed') {
        try {
            const maxRetries = 30;
            let retries = 0;
            
            while (retries < maxRetries) {
                const result = await this.makeRequest('getSignatureStatuses', [
                    [signature],
                    { searchTransactionHistory: true }
                ]);
                
                const status = result.value[0];
                if (status) {
                    if (status.confirmationStatus === commitment || status.confirmationStatus === 'finalized') {
                        return {
                            confirmed: true,
                            slot: status.slot,
                            err: status.err
                        };
                    }
                }
                
                // Wait 2 seconds before retry
                await new Promise(resolve => setTimeout(resolve, 2000));
                retries++;
            }
            
            return { confirmed: false, slot: null, err: 'Timeout' };
        } catch (error) {
            console.error('Failed to confirm transaction:', error);
            return { confirmed: false, slot: null, err: error.message };
        }
    }
    
    /**
     * Get recent blockhash
     */
    async getRecentBlockhash() {
        try {
            const result = await this.makeRequest('getLatestBlockhash', ['confirmed']);
            return result.value.blockhash;
        } catch (error) {
            console.error('Failed to get recent blockhash:', error);
            throw new Error('Failed to get recent blockhash');
        }
    }
    
    /**
     * Get minimum rent exemption
     */
    async getMinimumBalanceForRentExemption(dataLength) {
        try {
            const result = await this.makeRequest('getMinimumBalanceForRentExemption', [dataLength]);
            return result;
        } catch (error) {
            console.error('Failed to get rent exemption:', error);
            return 890880; // Default minimum
        }
    }
    
    /**
     * Estimate transaction fee
     */
    async estimateTransactionFee(transaction) {
        try {
            const serialized = transaction.serialize({ requireAllSignatures: false });
            const base64Transaction = Buffer.from(serialized).toString('base64');
            
            const result = await this.makeRequest('getFeeForMessage', [
                base64Transaction,
                { commitment: 'processed' }
            ]);
            
            return result.value || 5000; // Default 5000 lamports
        } catch (error) {
            console.error('Failed to estimate fee:', error);
            return 5000; // Default fallback
        }
    }
    
    /**
     * Get current slot
     */
    async getCurrentSlot() {
        try {
            const result = await this.makeRequest('getSlot', ['confirmed']);
            return result;
        } catch (error) {
            console.error('Failed to get current slot:', error);
            return 0;
        }
    }
    
    /**
     * Get network status
     */
    async getNetworkStatus() {
        try {
            const [health, version, slot] = await Promise.all([
                this.makeRequest('getHealth'),
                this.makeRequest('getVersion'),
                this.getCurrentSlot()
            ]);
            
            return {
                healthy: health === 'ok',
                version: version,
                currentSlot: slot,
                network: this.currentNetwork
            };
        } catch (error) {
            console.error('Failed to get network status:', error);
            return {
                healthy: false,
                version: null,
                currentSlot: 0,
                network: this.currentNetwork
            };
        }
    }
    
    /**
     * Switch network
     */
    switchNetwork(network) {
        if (this.networks[network]) {
            this.rpcUrl = this.networks[network];
            this.currentNetwork = network;
            this.clearCache(); // Clear cache when switching networks
            return true;
        }
        return false;
    }
    
    /**
     * Cache management
     */
    setCache(key, value, timeout = this.cacheTimeout) {
        this.cache.set(key, {
            value: value,
            timestamp: Date.now(),
            timeout: timeout
        });
    }
    
    getFromCache(key) {
        const cached = this.cache.get(key);
        if (cached && (Date.now() - cached.timestamp) < cached.timeout) {
            return cached.value;
        }
        this.cache.delete(key);
        return null;
    }
    
    clearCache() {
        this.cache.clear();
    }
    
    /**
     * Get performance metrics
     */
    async getPerformanceMetrics() {
        try {
            const start = Date.now();
            await this.makeRequest('getHealth');
            const latency = Date.now() - start;
            
            return {
                latency: latency,
                cacheSize: this.cache.size,
                network: this.currentNetwork,
                rpcUrl: this.rpcUrl
            };
        } catch (error) {
            return {
                latency: -1,
                cacheSize: this.cache.size,
                network: this.currentNetwork,
                rpcUrl: this.rpcUrl,
                error: error.message
            };
        }
    }
}

// Browser compatibility
if (typeof window !== 'undefined') {
    window.SolanaRPC = SolanaRPC;
} 