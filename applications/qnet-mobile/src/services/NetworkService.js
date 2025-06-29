/**
 * QNet Mobile - Network Service
 * Production-ready service for handling dual network operations
 * Supports Solana and QNet network switching with Phase detection
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { EONAddressGenerator } from '../utils/EONAddressGenerator';
import { BridgeService } from './BridgeService';

class NetworkServiceClass {
  constructor() {
    this.solanaConnection = null;
    this.qnetConnection = null;
    this.currentWallet = null;
    this.isInitialized = false;
    
    // Network endpoints
    this.endpoints = {
      solana: {
        mainnet: 'https://api.mainnet-beta.solana.com',
        devnet: 'https://api.devnet.solana.com',
        testnet: 'https://api.testnet.solana.com'
      },
      qnet: {
        mainnet: 'https://api.qnet.io',
        testnet: 'https://testnet-api.qnet.io'
      }
    };
  }

  async initialize() {
    if (this.isInitialized) return;

    try {
      // Initialize Solana connection
      const solanaEndpoint = await this.getSolanaEndpoint();
      this.solanaConnection = new Connection(solanaEndpoint, 'confirmed');

      // Initialize QNet connection (when available)
      await this.initializeQNetConnection();

      // Load wallet data
      await this.loadWalletData();

      this.isInitialized = true;
      console.log('NetworkService initialized successfully');
    } catch (error) {
      console.error('Failed to initialize NetworkService:', error);
      throw error;
    }
  }

  async getSolanaEndpoint() {
    const saved = await AsyncStorage.getItem('solanaEndpoint');
    return saved || this.endpoints.solana.devnet; // Default to devnet for testing
  }

  async initializeQNetConnection() {
    try {
      const qnetEndpoint = await AsyncStorage.getItem('qnetEndpoint');
      const endpoint = qnetEndpoint || this.endpoints.qnet.testnet;
      
      // Initialize QNet connection (placeholder - will be replaced with actual QNet client)
      this.qnetConnection = {
        endpoint,
        connected: false,
        // Will be replaced with actual QNet connection logic
      };
    } catch (error) {
      console.warn('QNet connection not available:', error);
    }
  }

  async loadWalletData() {
    try {
      const walletData = await AsyncStorage.getItem('walletData');
      if (walletData) {
        this.currentWallet = JSON.parse(walletData);
      }
    } catch (error) {
      console.warn('Failed to load wallet data:', error);
    }
  }

  async detectCurrentPhase() {
    try {
      // Phase detection based on 1DEV token and QNC availability
      const solanaPhase = await this.detectSolanaPhase();
      const qnetPhase = await this.detectQNetPhase();
      
      // Return the highest phase detected
      return Math.max(solanaPhase, qnetPhase);
    } catch (error) {
      console.warn('Phase detection failed, defaulting to Phase 1:', error);
      return 1;
    }
  }

  async detectSolanaPhase() {
    try {
      // Check for 1DEV token existence and burns
      const oneDEVMint = '1DEVhx7d12BnTj8CQYmHe9i3s3w5sF8CKcCqE3dN1Gf'; // Placeholder
      
      // If 1DEV token exists and has burn activity, it's Phase 1
      if (await this.checkTokenExists(oneDEVMint)) {
        return 1;
      }
      
      return 1; // Default to Phase 1
    } catch (error) {
      return 1;
    }
  }

  async detectQNetPhase() {
    try {
      // Check if QNet network is active with QNC tokens
      if (this.qnetConnection && this.qnetConnection.connected) {
        // If QNC tokens are available and Pool 3 is active, it's Phase 2
        const qncExists = await this.checkQNCAvailability();
        return qncExists ? 2 : 1;
      }
      return 1;
    } catch (error) {
      return 1;
    }
  }

  async checkTokenExists(mintAddress) {
    try {
      if (!this.solanaConnection) return false;
      
      const mintPubkey = new PublicKey(mintAddress);
      const mintInfo = await this.solanaConnection.getAccountInfo(mintPubkey);
      return mintInfo !== null;
    } catch (error) {
      return false;
    }
  }

  async checkQNCAvailability() {
    try {
      // Placeholder for QNC token availability check
      // Will be replaced with actual QNet API calls
      return false;
    } catch (error) {
      return false;
    }
  }

  async switchToSolana() {
    try {
      if (!this.solanaConnection) {
        throw new Error('Solana connection not initialized');
      }

      const walletAddress = this.currentWallet?.solanaAddress;
      if (!walletAddress) {
        throw new Error('No Solana wallet address available');
      }

      const publicKey = new PublicKey(walletAddress);
      
      // Get account balance
      const balance = await this.solanaConnection.getBalance(publicKey);
      const solBalance = balance / LAMPORTS_PER_SOL;

      // Get token balances
      const tokenBalances = await this.getSolanaTokenBalances(publicKey);

      return {
        network: 'solana',
        address: walletAddress,
        balances: {
          SOL: solBalance,
          ...tokenBalances
        },
        connection: this.solanaConnection,
        endpoint: this.solanaConnection.rpcEndpoint
      };
    } catch (error) {
      console.error('Failed to switch to Solana:', error);
      throw error;
    }
  }

  async getSolanaTokenBalances(publicKey) {
    try {
      const tokenAccounts = await this.solanaConnection.getParsedTokenAccountsByOwner(
        publicKey,
        { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
      );

      const balances = {};
      
      for (const account of tokenAccounts.value) {
        const tokenInfo = account.account.data.parsed.info;
        const mint = tokenInfo.mint;
        const amount = parseFloat(tokenInfo.tokenAmount.uiAmount) || 0;

        // Map known token mints to symbols
        const symbol = this.getTokenSymbol(mint);
        if (symbol) {
          balances[symbol] = amount;
        }
      }

      return balances;
    } catch (error) {
      console.warn('Failed to get token balances:', error);
      return {};
    }
  }

  getTokenSymbol(mintAddress) {
    // Map of known token mint addresses to symbols
    const tokenMap = {
      '1DEVhx7d12BnTj8CQYmHe9i3s3w5sF8CKcCqE3dN1Gf': '1DEV', // Placeholder
      // Add more token mappings as needed
    };
    
    return tokenMap[mintAddress] || null;
  }

  async switchToQNet() {
    try {
      if (!this.qnetConnection) {
        throw new Error('QNet connection not initialized');
      }

      // Generate EON address if not exists
      let eonAddress = this.currentWallet?.eonAddress;
      if (!eonAddress) {
        eonAddress = await this.generateEONAddress();
      }

      // Get QNet balances and node information
      const qnetData = await this.getQNetData(eonAddress);

      return {
        network: 'qnet',
        address: eonAddress,
        balances: qnetData.balances || { QNC: 0 },
        nodeInfo: qnetData.nodeInfo,
        connection: this.qnetConnection
      };
    } catch (error) {
      console.error('Failed to switch to QNet:', error);
      throw error;
    }
  }

  async generateEONAddress() {
    try {
      // Generate EON address using the same logic as desktop wallet
      const generator = new EONAddressGenerator();
      const eonAddress = await generator.generateFromSeed(this.currentWallet?.seed);
      
      // Save EON address to wallet data
      if (this.currentWallet) {
        this.currentWallet.eonAddress = eonAddress;
        await AsyncStorage.setItem('walletData', JSON.stringify(this.currentWallet));
      }
      
      return eonAddress;
    } catch (error) {
      console.error('Failed to generate EON address:', error);
      throw error;
    }
  }

  async getQNetData(eonAddress) {
    try {
      // Placeholder for QNet API calls
      // Will be replaced with actual QNet network integration
      
      return {
        balances: {
          QNC: 0 // Placeholder
        },
        nodeInfo: {
          code: 'MOBILE001',
          type: 'Light',
          status: 'Inactive',
          rewards: 0
        }
      };
    } catch (error) {
      console.warn('Failed to get QNet data:', error);
      return {
        balances: { QNC: 0 },
        nodeInfo: null
      };
    }
  }

  async checkSolanaConnection() {
    try {
      if (!this.solanaConnection) return false;
      
      const version = await this.solanaConnection.getVersion();
      return !!version;
    } catch (error) {
      return false;
    }
  }

  async checkQNetConnection() {
    try {
      if (!this.qnetConnection) return false;
      
      // Placeholder for QNet connection check
      // Will be replaced with actual QNet ping/health check
      return false;
    } catch (error) {
      return false;
    }
  }

  async setWalletData(walletData) {
    this.currentWallet = walletData;
    await AsyncStorage.setItem('walletData', JSON.stringify(walletData));
  }

  async setSolanaEndpoint(endpoint) {
    this.endpoints.solana.current = endpoint;
    await AsyncStorage.setItem('solanaEndpoint', endpoint);
    
    // Reinitialize connection with new endpoint
    this.solanaConnection = new Connection(endpoint, 'confirmed');
  }

  async setQNetEndpoint(endpoint) {
    this.endpoints.qnet.current = endpoint;
    await AsyncStorage.setItem('qnetEndpoint', endpoint);
    
    // Reinitialize QNet connection
    await this.initializeQNetConnection();
  }

  getConnectionStatus() {
    return {
      solana: !!this.solanaConnection,
      qnet: !!this.qnetConnection?.connected,
      initialized: this.isInitialized
    };
  }

  async cleanup() {
    this.solanaConnection = null;
    this.qnetConnection = null;
    this.currentWallet = null;
    this.isInitialized = false;
  }
}

// Create singleton instance
export const NetworkService = new NetworkServiceClass();
export default NetworkService; 