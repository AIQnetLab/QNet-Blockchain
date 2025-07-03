/**
 * Production Bridge Client for QNet Wallet
 * Enhanced bridge client with production-grade error handling, retries, and monitoring
 */

import { NetworkConfig } from '../config/NetworkConfig.js';

export class ProductionBridgeClient {
    constructor(networkManager) {
        this.networkManager = networkManager;
        this.config = new NetworkConfig();
        this.bridgeConfig = this.config.getBridgeConfig();
        this.retryConfig = this.config.getRetryConfig().bridge;
        this.timeoutConfig = this.config.getTimeoutConfig().bridge;
        
        // Connection state
        this.connected = false;
        this.lastHealthCheck = null;
        this.connectionAttempts = 0;
        this.maxConnectionAttempts = 5;
        
        // Request tracking
        this.activeRequests = new Map();
        this.requestCounter = 0;
        
        // WebSocket connection
        this.ws = null;
        this.wsReconnectAttempts = 0;
        this.maxWsReconnectAttempts = 10;
        
        // Event listeners
        this.listeners = new Set();
        
        this.init();
    }

    /**
     * Initialize production bridge client
     */
    async init() {
        try {
            await this.checkBridgeHealth();
            await this.establishWebSocketConnection();
            this.startHealthCheckInterval();
            
            console.log('Production bridge client initialized successfully');
        } catch (error) {
            console.error('Failed to initialize production bridge client:', error);
            throw error;
        }
    }

    /**
     * Check bridge health with production monitoring
     */
    async checkBridgeHealth() {
        try {
            const healthEndpoint = `${this.bridgeConfig.url}/api/v1/health`;
            const response = await this.makeRequest(healthEndpoint, {
                method: 'GET',
                timeout: 10000 // Short timeout for health check
            });

            const health = await response.json();
            
            this.connected = health.status === 'healthy';
            this.lastHealthCheck = Date.now();
            
            if (!this.connected) {
                throw new Error(`Bridge unhealthy: ${health.message || 'Unknown error'}`);
            }

            return {
                healthy: true,
                solanaConnected: health.solana_connected,
                qnetConnected: health.qnet_connected,
                version: health.version,
                uptime: health.uptime,
                lastUpdate: health.last_update
            };

        } catch (error) {
            this.connected = false;
            console.error('Bridge health check failed:', error);
            throw error;
        }
    }

    /**
     * Establish WebSocket connection for real-time updates
     */
    async establishWebSocketConnection() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            return;
        }

        try {
            this.ws = new WebSocket(this.bridgeConfig.wsUrl);
            
            this.ws.onopen = () => {
                console.log('Bridge WebSocket connected');
                this.wsReconnectAttempts = 0;
                this.notifyListeners('wsConnected', {});
            };

            this.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    this.handleWebSocketMessage(data);
                } catch (error) {
                    console.error('Failed to parse WebSocket message:', error);
                }
            };

            this.ws.onclose = (event) => {
                console.log('Bridge WebSocket disconnected:', event.code, event.reason);
                this.scheduleWebSocketReconnect();
            };

            this.ws.onerror = (error) => {
                console.error('Bridge WebSocket error:', error);
            };

        } catch (error) {
            console.error('Failed to establish WebSocket connection:', error);
            this.scheduleWebSocketReconnect();
        }
    }

    /**
     * Handle WebSocket message
     */
    handleWebSocketMessage(data) {
        switch (data.type) {
            case 'activation_status_update':
                this.notifyListeners('activationStatusUpdate', data.payload);
                break;
            case 'burn_verified':
                this.notifyListeners('burnVerified', data.payload);
                break;
            case 'bridge_status':
                this.notifyListeners('bridgeStatus', data.payload);
                break;
            case 'network_phase_change':
                this.notifyListeners('phaseChange', data.payload);
                break;
            default:
                console.log('Unknown WebSocket message type:', data.type);
        }
    }

    /**
     * Schedule WebSocket reconnection
     */
    scheduleWebSocketReconnect() {
        if (this.wsReconnectAttempts >= this.maxWsReconnectAttempts) {
            console.error('Max WebSocket reconnection attempts reached');
            return;
        }

        const delay = Math.min(1000 * Math.pow(2, this.wsReconnectAttempts), 30000);
        this.wsReconnectAttempts++;

        setTimeout(() => {
            console.log(`Attempting WebSocket reconnection (${this.wsReconnectAttempts}/${this.maxWsReconnectAttempts})`);
            this.establishWebSocketConnection();
        }, delay);
    }

    /**
     * Request activation token with production error handling
     */
    async requestActivationToken(burnTx, nodeType, qnetPublicKey, solanaAddress) {
        const requestId = this.generateRequestId();
        
        try {
            const requestData = {
                request_id: requestId,
                qnet_pubkey: qnetPublicKey,
                solana_txid: burnTx.signature,
                solana_pubkey_user: solanaAddress,
                node_type: nodeType,
                burn_amount: burnTx.amount,
                timestamp: burnTx.timestamp,
                client_version: '1.0.0'
            };

            console.log('Requesting activation token:', { requestId, nodeType, burnAmount: burnTx.amount });

            const response = await this.makeRequestWithRetry('/api/v1/request_activation_token', {
                method: 'POST',
                body: JSON.stringify(requestData)
            });

            if (response.success) {
                // Track request for monitoring
                this.trackActivationRequest(requestId, response);

                return {
                    success: true,
                    requestId,
                    activationCode: response.activation_code,
                    nodeId: response.node_id,
                    expiresAt: response.expires_at,
                    bridgeSignature: response.bridge_signature,
                    estimatedCompletionTime: response.estimated_completion_time
                };
            } else {
                throw new Error(response.error || 'Bridge request failed');
            }

        } catch (error) {
            console.error('Failed to request activation token:', error);
            this.trackFailedRequest(requestId, error);
            throw error;
        }
    }

    /**
     * Verify burn transaction with enhanced validation
     */
    async verifyBurnTransaction(txSignature, expectedAmount, burnerAddress) {
        try {
            const requestData = {
                tx_signature: txSignature,
                expected_amount: expectedAmount,
                burner_address: burnerAddress,
                verification_level: 'strict' // Production verification
            };

            const response = await this.makeRequestWithRetry('/api/v1/verify_burn', {
                method: 'POST',
                body: JSON.stringify(requestData)
            });

            return {
                verified: response.verified || false,
                burnAmount: response.burn_amount,
                burnTimestamp: response.burn_timestamp,
                blockHeight: response.block_height,
                confirmations: response.confirmations,
                finalized: response.finalized,
                verificationLevel: response.verification_level
            };

        } catch (error) {
            console.error('Failed to verify burn transaction:', error);
            return { 
                verified: false, 
                error: error.message,
                verificationLevel: 'failed'
            };
        }
    }

    /**
     * Get activation status with real-time updates
     */
    async getActivationStatus(activationCode) {
        try {
            const response = await this.makeRequestWithRetry(`/api/v1/activation_status/${activationCode}`, {
                method: 'GET'
            });

            return {
                status: response.status, // 'pending', 'verified', 'activated', 'failed', 'expired'
                nodeId: response.node_id,
                activatedAt: response.activated_at,
                qnetTxHash: response.qnet_tx_hash,
                details: response.details,
                progress: response.progress,
                estimatedCompletion: response.estimated_completion,
                lastUpdate: response.last_update
            };

        } catch (error) {
            console.error('Failed to get activation status:', error);
            return { 
                status: 'unknown', 
                error: error.message,
                lastUpdate: Date.now()
            };
        }
    }

    /**
     * Get comprehensive bridge statistics
     */
    async getBridgeStats() {
        try {
            const response = await this.makeRequestWithRetry('/api/v1/stats', {
                method: 'GET'
            });

            return {
                totalBurned: response.total_burned,
                totalActivations: response.total_activations,
                burnProgress: response.burn_progress,
                phaseStatus: response.phase_status,
                activeNodes: response.active_nodes,
                networkHealth: response.network_health,
                bridgeVersion: response.bridge_version,
                uptime: response.uptime,
                requestsProcessed: response.requests_processed,
                averageProcessingTime: response.average_processing_time,
                successRate: response.success_rate
            };

        } catch (error) {
            console.error('Failed to get bridge stats:', error);
            return null;
        }
    }

    /**
     * Make HTTP request with retry logic and monitoring
     */
    async makeRequestWithRetry(endpoint, options = {}) {
        let lastError;
        
        for (let attempt = 1; attempt <= this.retryConfig.attempts; attempt++) {
            try {
                const response = await this.makeRequest(endpoint, options);
                
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`HTTP ${response.status}: ${errorText}`);
                }

                const data = await response.json();
                
                // Log successful request for monitoring
                this.logRequestMetrics(endpoint, attempt, true);
                
                return data;

            } catch (error) {
                lastError = error;
                
                console.warn(`Request attempt ${attempt}/${this.retryConfig.attempts} failed:`, error.message);
                
                // Don't retry on client errors (4xx)
                if (error.message.includes('HTTP 4')) {
                    break;
                }
                
                // Wait before retry (except on last attempt)
                if (attempt < this.retryConfig.attempts) {
                    const delay = this.retryConfig.delay * Math.pow(this.retryConfig.backoff, attempt - 1);
                    await this.sleep(delay);
                }
            }
        }

        // Log failed request for monitoring
        this.logRequestMetrics(endpoint, this.retryConfig.attempts, false, lastError);
        
        throw lastError;
    }

    /**
     * Make HTTP request with timeout and monitoring
     */
    async makeRequest(endpoint, options = {}) {
        const url = endpoint.startsWith('http') ? endpoint : `${this.bridgeConfig.url}${endpoint}`;
        
        const defaultOptions = {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'QNet-Wallet/1.0.0',
                'X-Client-Version': '1.0.0',
                'X-Environment': this.config.getEnvironment()
            },
            timeout: options.timeout || this.timeoutConfig
        };

        const requestOptions = {
            ...defaultOptions,
            ...options,
            headers: {
                ...defaultOptions.headers,
                ...options.headers
            }
        };

        // Add request tracking
        const requestId = this.generateRequestId();
        const startTime = Date.now();
        
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), requestOptions.timeout);

            const response = await fetch(url, {
                ...requestOptions,
                signal: controller.signal
            });

            clearTimeout(timeoutId);
            
            // Track request metrics
            const duration = Date.now() - startTime;
            this.trackRequestMetrics(endpoint, duration, response.status);

            return response;

        } catch (error) {
            const duration = Date.now() - startTime;
            
            if (error.name === 'AbortError') {
                throw new Error(`Request timeout after ${requestOptions.timeout}ms`);
            }
            
            this.trackRequestMetrics(endpoint, duration, 0, error);
            throw error;
        }
    }

    /**
     * Track activation request for monitoring
     */
    trackActivationRequest(requestId, response) {
        this.activeRequests.set(requestId, {
            timestamp: Date.now(),
            status: 'pending',
            activationCode: response.activation_code,
            nodeId: response.node_id,
            expiresAt: response.expires_at
        });

        // Clean up old requests
        this.cleanupOldRequests();
    }

    /**
     * Track failed request
     */
    trackFailedRequest(requestId, error) {
        this.activeRequests.set(requestId, {
            timestamp: Date.now(),
            status: 'failed',
            error: error.message
        });
    }

    /**
     * Track request metrics for monitoring
     */
    trackRequestMetrics(endpoint, duration, statusCode, error = null) {
        const metrics = {
            endpoint,
            duration,
            statusCode,
            success: statusCode >= 200 && statusCode < 300,
            timestamp: Date.now(),
            error: error?.message
        };

        // Store metrics for monitoring dashboard
        this.storeMetrics(metrics);
    }

    /**
     * Store metrics for monitoring
     */
    storeMetrics(metrics) {
        // This would integrate with monitoring system
        // For now, just log for development
        if (!this.config.isProduction()) {
            console.log('Bridge request metrics:', metrics);
        }
    }

    /**
     * Log request metrics
     */
    logRequestMetrics(endpoint, attempts, success, error = null) {
        const logData = {
            endpoint,
            attempts,
            success,
            timestamp: Date.now(),
            error: error?.message
        };

        if (success) {
            console.log('Bridge request successful:', logData);
        } else {
            console.error('Bridge request failed:', logData);
        }
    }

    /**
     * Start health check interval
     */
    startHealthCheckInterval() {
        // Check bridge health every 30 seconds
        setInterval(async () => {
            try {
                await this.checkBridgeHealth();
            } catch (error) {
                console.warn('Periodic health check failed:', error);
            }
        }, 30000);
    }

    /**
     * Clean up old requests
     */
    cleanupOldRequests() {
        const cutoff = Date.now() - (24 * 60 * 60 * 1000); // 24 hours
        
        for (const [requestId, request] of this.activeRequests.entries()) {
            if (request.timestamp < cutoff) {
                this.activeRequests.delete(requestId);
            }
        }
    }

    /**
     * Generate unique request ID
     */
    generateRequestId() {
        return `req_${Date.now()}_${++this.requestCounter}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Sleep utility
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Add event listener
     */
    addListener(callback) {
        this.listeners.add(callback);
    }

    /**
     * Remove event listener
     */
    removeListener(callback) {
        this.listeners.delete(callback);
    }

    /**
     * Notify listeners
     */
    notifyListeners(event, data) {
        for (const listener of this.listeners) {
            try {
                listener(event, data);
            } catch (error) {
                console.error('Listener error:', error);
            }
        }
    }

    /**
     * Get connection status
     */
    getConnectionStatus() {
        return {
            connected: this.connected,
            lastHealthCheck: this.lastHealthCheck,
            connectionAttempts: this.connectionAttempts,
            activeRequests: this.activeRequests.size,
            wsConnected: this.ws?.readyState === WebSocket.OPEN,
            wsReconnectAttempts: this.wsReconnectAttempts
        };
    }

    /**
     * Get request statistics
     */
    getRequestStats() {
        return {
            activeRequests: this.activeRequests.size,
            totalRequests: this.requestCounter,
            pendingRequests: Array.from(this.activeRequests.values()).filter(r => r.status === 'pending').length,
            failedRequests: Array.from(this.activeRequests.values()).filter(r => r.status === 'failed').length
        };
    }

    /**
     * Destroy bridge client
     */
    destroy() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        
        this.activeRequests.clear();
        this.listeners.clear();
        this.connected = false;
    }
} 