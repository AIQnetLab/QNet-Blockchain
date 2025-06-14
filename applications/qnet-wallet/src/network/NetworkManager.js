// QNet Network Manager

export class NetworkManager {
    constructor() {
        this.baseUrl = 'http://localhost:8080'; // Default local node
        this.networkId = 'qnet-mainnet';
        this.connected = false;
        this.ws = null;
    }
    
    // Set network endpoint
    setEndpoint(url) {
        this.baseUrl = url;
    }
    
    // Connect to network
    async connect() {
        try {
            // Test connection
            const response = await fetch(`${this.baseUrl}/api/v1/status`);
            if (response.ok) {
                this.connected = true;
                this.connectWebSocket();
                return true;
            }
        } catch (error) {
            console.error('Failed to connect to network:', error);
            this.connected = false;
        }
        return false;
    }
    
    // Connect WebSocket for real-time updates
    connectWebSocket() {
        const wsUrl = this.baseUrl.replace('http', 'ws') + '/ws';
        this.ws = new WebSocket(wsUrl);
        
        this.ws.onopen = () => {
            console.log('WebSocket connected');
        };
        
        this.ws.onmessage = (event) => {
            this.handleWebSocketMessage(event.data);
        };
        
        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
        };
        
        this.ws.onclose = () => {
            console.log('WebSocket disconnected');
            // Reconnect after 5 seconds
            setTimeout(() => {
                if (this.connected) {
                    this.connectWebSocket();
                }
            }, 5000);
        };
    }
    
    // Handle WebSocket messages
    handleWebSocketMessage(data) {
        try {
            const message = JSON.parse(data);
            
            switch (message.type) {
                case 'balance_update':
                    // Notify about balance update
                    chrome.runtime.sendMessage({
                        action: 'balanceUpdate',
                        data: message.data
                    }).catch(() => {});
                    break;
                    
                case 'new_transaction':
                    // Notify about new transaction
                    chrome.runtime.sendMessage({
                        action: 'newTransaction',
                        data: message.data
                    }).catch(() => {});
                    break;
                    
                case 'node_status':
                    // Update node status
                    chrome.runtime.sendMessage({
                        action: 'nodeStatusUpdate',
                        data: message.data
                    }).catch(() => {});
                    break;
            }
        } catch (error) {
            console.error('Error handling WebSocket message:', error);
        }
    }
    
    // Get balance
    async getBalance(address) {
        try {
            const response = await fetch(`${this.baseUrl}/api/v1/balance/${address}`);
            if (response.ok) {
                const data = await response.json();
                return data.balance;
            }
        } catch (error) {
            console.error('Error fetching balance:', error);
        }
        return 0;
    }
    
    // Get transactions
    async getTransactions(address, limit = 20, offset = 0) {
        try {
            const response = await fetch(
                `${this.baseUrl}/api/v1/transactions/${address}?limit=${limit}&offset=${offset}`
            );
            if (response.ok) {
                const data = await response.json();
                return data.transactions || [];
            }
        } catch (error) {
            console.error('Error fetching transactions:', error);
        }
        return [];
    }
    
    // Get nonce
    async getNonce(address) {
        try {
            const response = await fetch(`${this.baseUrl}/api/v1/nonce/${address}`);
            if (response.ok) {
                const data = await response.json();
                return data.nonce;
            }
        } catch (error) {
            console.error('Error fetching nonce:', error);
        }
        return 0;
    }
    
    // Broadcast transaction
    async broadcastTransaction(tx) {
        try {
            const response = await fetch(`${this.baseUrl}/api/v1/transaction`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(tx)
            });
            
            if (response.ok) {
                const data = await response.json();
                return data.txHash;
            } else {
                const error = await response.json();
                throw new Error(error.message || 'Transaction failed');
            }
        } catch (error) {
            console.error('Error broadcasting transaction:', error);
            throw error;
        }
    }
    
    // Get transaction status
    async getTransactionStatus(txHash) {
        try {
            const response = await fetch(`${this.baseUrl}/api/v1/transaction/${txHash}`);
            if (response.ok) {
                const data = await response.json();
                return data;
            }
        } catch (error) {
            console.error('Error fetching transaction status:', error);
        }
        return null;
    }
    
    // Estimate transaction fee
    async estimateFee(from, to, amount) {
        try {
            const response = await fetch(`${this.baseUrl}/api/v1/estimate-fee`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ from, to, amount })
            });
            
            if (response.ok) {
                const data = await response.json();
                return data.fee;
            }
        } catch (error) {
            console.error('Error estimating fee:', error);
        }
        return 0.001; // Default fee
    }
    
    // Get current gas price
    async getGasPrice() {
        try {
            const response = await fetch(`${this.baseUrl}/api/v1/gas-price`);
            if (response.ok) {
                const data = await response.json();
                return data.gasPrice;
            }
        } catch (error) {
            console.error('Error fetching gas price:', error);
        }
        return 10; // Default gas price
    }
    
    // Estimate gas for transaction
    async estimateGas(from, to, amount, data = null) {
        try {
            const response = await fetch(`${this.baseUrl}/api/v1/estimate-gas`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ from, to, amount, data })
            });
            
            if (response.ok) {
                const data = await response.json();
                return data.gasLimit;
            }
        } catch (error) {
            console.error('Error estimating gas:', error);
        }
        return 21000; // Default gas limit
    }
    
    // Get network status
    async getNetworkStatus() {
        try {
            const response = await fetch(`${this.baseUrl}/api/v1/network/status`);
            if (response.ok) {
                const data = await response.json();
                return data;
            }
        } catch (error) {
            console.error('Error fetching network status:', error);
        }
        return null;
    }
    
    // Get node info
    async getNodeInfo() {
        try {
            const response = await fetch(`${this.baseUrl}/api/v1/node/info`);
            if (response.ok) {
                const data = await response.json();
                return data;
            }
        } catch (error) {
            console.error('Error fetching node info:', error);
        }
        return null;
    }
    
    // Activate node
    async activateNode(nodeType, ownerAddress, burnTxHash) {
        try {
            const response = await fetch(`${this.baseUrl}/api/v1/node/activate`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    nodeType,
                    ownerAddress,
                    burnTxHash
                })
            });
            
            if (response.ok) {
                const data = await response.json();
                return data.nodeId;
            } else {
                const error = await response.json();
                throw new Error(error.message || 'Node activation failed');
            }
        } catch (error) {
            console.error('Error activating node:', error);
            throw error;
        }
    }
    
    // Get node rewards
    async getNodeRewards(nodeId) {
        try {
            const response = await fetch(`${this.baseUrl}/api/v1/node/${nodeId}/rewards`);
            if (response.ok) {
                const data = await response.json();
                return data.rewards;
            }
        } catch (error) {
            console.error('Error fetching node rewards:', error);
        }
        return 0;
    }
    
    // Claim node rewards
    async claimNodeRewards(nodeId, ownerAddress, signature) {
        try {
            const response = await fetch(`${this.baseUrl}/api/v1/node/${nodeId}/claim`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    ownerAddress,
                    signature
                })
            });
            
            if (response.ok) {
                const data = await response.json();
                return data.amount;
            } else {
                const error = await response.json();
                throw new Error(error.message || 'Claim failed');
            }
        } catch (error) {
            console.error('Error claiming rewards:', error);
            throw error;
        }
    }
    
    // Get QNC price
    async getQNCPrice() {
        try {
            const response = await fetch(`${this.baseUrl}/api/v1/price/qnc`);
            if (response.ok) {
                const data = await response.json();
                return data.price;
            }
        } catch (error) {
            console.error('Error fetching QNC price:', error);
        }
        return 0;
    }
    
    // Disconnect
    disconnect() {
        this.connected = false;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
} 