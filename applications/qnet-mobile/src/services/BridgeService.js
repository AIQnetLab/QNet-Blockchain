/**
 * QNet Mobile - Bridge Service
 * Production-ready service for connecting to QNet activation bridge
 * Handles Phase 1 (1DEV burn) and Phase 2 (QNC transfer-to-Pool3) activation
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert } from 'react-native';

class BridgeServiceClass {
  constructor() {
    // QUANTUM P2P: Direct connection to QNet nodes (no bridge servers needed)
    this.qnetEndpoints = {
      testnet: [
        'https://testnet-rpc.qnet.io',         // Primary testnet
        'http://localhost:8001',              // Local node 1
        'http://localhost:8002',              // Local node 2
        'http://localhost:8003'               // Local node 3
      ],
      mainnet: [
        'https://rpc.qnet.io',                // Primary mainnet
        'https://rpc-eu.qnet.io',             // Europe
        'https://rpc-asia.qnet.io',           // Asia
        'https://rpc-us.qnet.io'              // US backup
      ],
      local: ['http://localhost:8001', 'http://localhost:8002', 'http://localhost:8003']
    };
    
    // Auto-detect network from environment
    const networkEnv = process.env.QNET_NETWORK || 'testnet';
    this.currentEndpoints = this.qnetEndpoints[networkEnv] || this.qnetEndpoints.testnet;
    this.endpointIndex = 0;
    this.isConnected = false;
    this.authToken = null;
    
    // Phase 2 QNC activation costs with network size multipliers
    this.qncActivationCosts = {
      baseMultipliers: {
        '0-100k': 0.5,
        '100k-1m': 1.0,
        '1m-10m': 2.0,
        '10m+': 3.0
      },
      baseCosts: {
        Light: 5000,
        Full: 7500,
        Super: 10000
      }
    };
  }

  async initialize() {
    try {
      // Load saved endpoint and auth token
      const savedEndpoint = await AsyncStorage.getItem('bridgeEndpoint');
      if (savedEndpoint) {
        this.currentEndpoint = savedEndpoint;
      }

      const savedAuth = await AsyncStorage.getItem('bridgeAuth');
      if (savedAuth) {
        this.authToken = JSON.parse(savedAuth);
      }

      // Test connection
      await this.testConnection();
      
      console.log('BridgeService initialized successfully');
    } catch (error) {
      console.warn('BridgeService initialization failed:', error);
    }
  }

  async testConnection() {
    try {
      const response = await fetch(`${this.currentEndpoint}/api/health`, {
        method: 'GET',
        timeout: 5000
      });

      if (response.ok) {
        this.isConnected = true;
        return true;
      } else {
        this.isConnected = false;
        return false;
      }
    } catch (error) {
      console.warn('Bridge connection test failed:', error);
      this.isConnected = false;
      return false;
    }
  }

  async authenticateWallet(walletAddress, signature) {
    try {
      const response = await fetch(`${this.currentEndpoint}/api/auth/wallet`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          address: walletAddress,
          signature: signature,
          timestamp: Date.now()
        })
      });

      const data = await response.json();
      
      if (response.ok && data.token) {
        this.authToken = {
          token: data.token,
          expires: data.expires,
          address: walletAddress
        };
        
        await AsyncStorage.setItem('bridgeAuth', JSON.stringify(this.authToken));
        return true;
      } else {
        throw new Error(data.error || 'Authentication failed');
      }
    } catch (error) {
      console.error('Wallet authentication failed:', error);
      throw error;
    }
  }

  async getPhaseInfo() {
    try {
      const response = await this.makeAuthenticatedRequest('/api/phase/info');
      return response;
    } catch (error) {
      console.error('Failed to get phase info:', error);
      return {
        currentPhase: 1,
        phase1Active: true,
        phase2Active: false,
        networkSize: 0
      };
    }
  }

  async startPhase1Activation(walletAddress, devTokenAmount) {
    try {
      if (!devTokenAmount || devTokenAmount <= 0) {
        throw new Error('Invalid 1DEV token amount');
      }

      const response = await this.makeAuthenticatedRequest('/api/phase1/activate', {
        method: 'POST',
        body: JSON.stringify({
          walletAddress,
          devTokenAmount,
          timestamp: Date.now()
        })
      });

      if (response.success) {
        return {
          success: true,
          activationId: response.activationId,
          burnTransaction: response.burnTransaction,
          nodeCode: response.nodeCode,
          nodeType: response.nodeType,
          estimatedActivation: response.estimatedActivation
        };
      } else {
        throw new Error(response.error || 'Phase 1 activation failed');
      }
    } catch (error) {
      console.error('Phase 1 activation failed:', error);
      throw error;
    }
  }

  async startPhase2Activation(eonAddress, nodeType, qncAmount) {
    try {
      // Validate node type
      if (!['Light', 'Full', 'Super'].includes(nodeType)) {
        throw new Error('Invalid node type');
      }

      // Calculate required QNC amount based on network size
      const requiredQNC = await this.calculateRequiredQNC(nodeType);
      
      if (qncAmount < requiredQNC) {
        throw new Error(`Insufficient QNC. Required: ${requiredQNC}, Provided: ${qncAmount}`);
      }

      const response = await this.makeAuthenticatedRequest('/api/phase2/activate', {
        method: 'POST',
        body: JSON.stringify({
          eonAddress,
          nodeType,
          qncAmount,
          timestamp: Date.now()
        })
      });

      if (response.success) {
        return {
          success: true,
          activationId: response.activationId,
          nodeCode: response.nodeCode,
          poolDistribution: response.poolDistribution,
          estimatedRewards: response.estimatedRewards,
          activationTime: response.activationTime
        };
      } else {
        throw new Error(response.error || 'Phase 2 activation failed');
      }
    } catch (error) {
      console.error('Phase 2 activation failed:', error);
      throw error;
    }
  }

  async calculateRequiredQNC(nodeType) {
    try {
      // Get current network size
      const phaseInfo = await this.getPhaseInfo();
      const networkSize = phaseInfo.networkSize || 0;
      
      // Determine multiplier based on network size
      let multiplier = 1.0;
      if (networkSize < 100000) {
        multiplier = this.qncActivationCosts.baseMultipliers['0-100k'];
      } else if (networkSize < 1000000) {
        multiplier = this.qncActivationCosts.baseMultipliers['100k-1m'];
      } else if (networkSize < 10000000) {
        multiplier = this.qncActivationCosts.baseMultipliers['1m-10m'];
      } else {
        multiplier = this.qncActivationCosts.baseMultipliers['10m+'];
      }
      
      // Calculate final cost
      const baseCost = this.qncActivationCosts.baseCosts[nodeType];
      return Math.floor(baseCost * multiplier);
    } catch (error) {
      console.warn('Failed to calculate QNC cost, using base cost:', error);
      return this.qncActivationCosts.baseCosts[nodeType] || 5000;
    }
  }

  async getActivationStatus(activationId) {
    try {
      const response = await this.makeAuthenticatedRequest(`/api/activation/status/${activationId}`);
      return response;
    } catch (error) {
      console.error('Failed to get activation status:', error);
      return {
        status: 'unknown',
        error: error.message
      };
    }
  }

  async getNodeInfo(nodeCode) {
    try {
      const response = await this.makeAuthenticatedRequest(`/api/node/info/${nodeCode}`);
      return response;
    } catch (error) {
      console.error('Failed to get node info:', error);
      return null;
    }
  }

  async submitBurnProof(activationId, burnTxHash, burnAmount) {
    try {
      const response = await this.makeAuthenticatedRequest('/api/phase1/burn-proof', {
        method: 'POST',
        body: JSON.stringify({
          activationId,
          burnTxHash,
          burnAmount,
          timestamp: Date.now()
        })
      });

      return response;
    } catch (error) {
      console.error('Failed to submit burn proof:', error);
      throw error;
    }
  }

  async makeAuthenticatedRequest(endpoint, options = {}) {
    try {
      if (!this.authToken || this.isTokenExpired()) {
        throw new Error('No valid authentication token');
      }

      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.authToken.token}`,
        ...options.headers
      };

      const response = await fetch(`${this.currentEndpoint}${endpoint}`, {
        ...options,
        headers,
        timeout: 10000
      });

      if (response.status === 401) {
        // Token expired, clear auth
        this.authToken = null;
        await AsyncStorage.removeItem('bridgeAuth');
        throw new Error('Authentication expired');
      }

      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      return data;
    } catch (error) {
      console.error('Authenticated request failed:', error);
      throw error;
    }
  }

  isTokenExpired() {
    if (!this.authToken || !this.authToken.expires) {
      return true;
    }
    
    return Date.now() > this.authToken.expires;
  }

  async setBridgeEndpoint(endpoint) {
    this.currentEndpoint = endpoint;
    await AsyncStorage.setItem('bridgeEndpoint', endpoint);
    
    // Test new endpoint
    const connected = await this.testConnection();
    return connected;
  }

  async getNetworkStats() {
    try {
      const response = await this.makeAuthenticatedRequest('/api/network/stats');
      return response;
    } catch (error) {
      console.warn('Failed to get network stats:', error);
      return {
        totalNodes: 0,
        activeNodes: 0,
        networkSize: 0,
        totalQNCInPool3: 0,
        phase1Activations: 0,
        phase2Activations: 0
      };
    }
  }

  async getQNCPoolInfo() {
    try {
      const response = await this.makeAuthenticatedRequest('/api/pool3/info');
      return response;
    } catch (error) {
      console.warn('Failed to get Pool 3 info:', error);
      return {
        totalQNC: 0,
        dailyDistribution: 0,
        activeNodes: 0,
        rewardsPerNode: 0
      };
    }
  }

  getConnectionStatus() {
    return {
      connected: this.isConnected,
      endpoint: this.currentEndpoint,
      authenticated: !!this.authToken && !this.isTokenExpired()
    };
  }

  async disconnect() {
    this.isConnected = false;
    this.authToken = null;
    await AsyncStorage.removeItem('bridgeAuth');
  }
}

// Create singleton instance
export const BridgeService = new BridgeServiceClass();
export default BridgeService; 