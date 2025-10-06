'use client';

import React, { useState, useEffect } from 'react';
import { Button } from '../ui/button';

interface QNetWallet {
  isQNet?: boolean;
  connect: () => Promise<string[]>;
  disconnect: () => Promise<void>;
  getBalance?: () => Promise<number>;
  getNetwork?: () => Promise<string>;
  switchNetwork?: (network: string) => Promise<void>;
  signTransaction?: (tx: any) => Promise<string>;
  on?: (event: string, callback: Function) => void;
  removeListener?: (event: string, callback: Function) => void;
  request?: (args: { method: string; params?: any[] }) => Promise<any>;
  isConnected?: () => boolean;
  connected?: boolean;
  selectedAddress?: string | null;
  networkVersion?: string;
  version?: string;
}

// Don't redeclare window.qnet since it's already declared in AppContext.tsx
// Just extend the Window interface for ethereum
declare global {
  interface Window {
    ethereum?: any;
  }
}

export default function WalletConnection() {
  const [isConnected, setIsConnected] = useState(false);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletType, setWalletType] = useState<'qnet' | 'phantom' | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [balance, setBalance] = useState<number>(0);
  const [network, setNetwork] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    checkWalletConnection();
    setupWalletListeners();
    
    return () => {
      cleanupWalletListeners();
    };
  }, []);

  /**
   * Check for existing wallet connections
   */
  const checkWalletConnection = async () => {
    try {
      // Check QNet Wallet first (priority)
      if (window.qnet) {
        console.log('QNet Wallet detected');
        await checkQNetConnection();
      }
      // Fallback to Phantom for Solana
      else if (window.ethereum || (window as any).solana) {
        console.log('Phantom Wallet detected');
        await checkPhantomConnection();
      }
    } catch (error) {
      console.error('Error checking wallet connection:', error);
    }
  };

  /**
   * Check QNet Wallet connection
   */
  const checkQNetConnection = async () => {
    if (!window.qnet) return;

    try {
      const accounts = await window.qnet.connect();
      if (accounts && accounts.length > 0) {
        setIsConnected(true);
        setWalletAddress(accounts[0]);
        setWalletType('qnet');
        
        // Get additional info
        const balance = window.qnet.getBalance ? await window.qnet.getBalance() : 0;
        const network = window.qnet.getNetwork ? await window.qnet.getNetwork() : 'qnet';
        
        setBalance(balance);
        setNetwork(network);
        setError(null);
      }
    } catch (error) {
      console.error('QNet wallet connection check failed:', error);
    }
  };

  /**
   * Check Phantom Wallet connection
   */
  const checkPhantomConnection = async () => {
    const phantom = (window as any).solana;
    if (!phantom?.isPhantom) return;

    try {
      if (phantom.isConnected) {
        setIsConnected(true);
        setWalletAddress(phantom.publicKey.toString());
        setWalletType('phantom');
        setNetwork('solana');
        setError(null);
      }
    } catch (error) {
      console.error('Phantom wallet connection check failed:', error);
    }
  };

  /**
   * Setup wallet event listeners
   */
  const setupWalletListeners = () => {
    // QNet Wallet listeners
    if (window.qnet && window.qnet.on) {
      window.qnet.on('accountsChanged', handleAccountsChanged);
      window.qnet.on('networkChanged', handleNetworkChanged);
      window.qnet.on('disconnect', handleDisconnect);
    }

    // Phantom listeners
    const phantom = (window as any).solana;
    if (phantom && phantom.on) {
      phantom.on('accountChanged', handleAccountsChanged);
      phantom.on('disconnect', handleDisconnect);
    }
  };

  /**
   * Cleanup wallet event listeners
   */
  const cleanupWalletListeners = () => {
    if (window.qnet && window.qnet.removeListener) {
      window.qnet.removeListener('accountsChanged', handleAccountsChanged);
      window.qnet.removeListener('networkChanged', handleNetworkChanged);
      window.qnet.removeListener('disconnect', handleDisconnect);
    }

    const phantom = (window as any).solana;
    if (phantom && phantom.removeListener) {
      phantom.removeListener('accountChanged', handleAccountsChanged);
      phantom.removeListener('disconnect', handleDisconnect);
    }
  };

  /**
   * Handle account changes
   */
  const handleAccountsChanged = (accounts: string[]) => {
    if (accounts.length === 0) {
      handleDisconnect();
    } else {
      setWalletAddress(accounts[0]);
      updateWalletInfo();
    }
  };

  /**
   * Handle network changes
   */
  const handleNetworkChanged = (network: string) => {
    setNetwork(network);
    updateWalletInfo();
  };

  /**
   * Handle wallet disconnect
   */
  const handleDisconnect = () => {
    setIsConnected(false);
    setWalletAddress(null);
    setWalletType(null);
    setBalance(0);
    setNetwork('');
    setError(null);
  };

  /**
   * Update wallet information
   */
  const updateWalletInfo = async () => {
    try {
      if (walletType === 'qnet' && window.qnet) {
        const balance = window.qnet.getBalance ? await window.qnet.getBalance() : 0;
        const network = window.qnet.getNetwork ? await window.qnet.getNetwork() : 'qnet';
        setBalance(balance);
        setNetwork(network);
      }
    } catch (error) {
      console.error('Failed to update wallet info:', error);
    }
  };

  /**
   * Connect QNet Wallet
   */
  const connectQNetWallet = async () => {
    setIsConnecting(true);
    setError(null);

    try {
      if (!window.qnet) {
        // Try to detect QNet Wallet extension
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        if (!window.qnet) {
          throw new Error('QNet Wallet extension not found. Please install QNet Wallet.');
        }
      }

      const accounts = await window.qnet.connect();
      
      if (accounts && accounts.length > 0) {
        setIsConnected(true);
        setWalletAddress(accounts[0]);
        setWalletType('qnet');
        
        // Get wallet info
        const balance = window.qnet.getBalance ? await window.qnet.getBalance() : 0;
        const network = window.qnet.getNetwork ? await window.qnet.getNetwork() : 'qnet';
        
        setBalance(balance);
        setNetwork(network);
        
        console.log('QNet Wallet connected successfully');
      } else {
        throw new Error('No accounts found in QNet Wallet');
      }
    } catch (error: any) {
      console.error('Failed to connect QNet Wallet:', error);
      setError(error.message || 'Failed to connect QNet Wallet');
    } finally {
      setIsConnecting(false);
    }
  };

  /**
   * Connect Phantom Wallet
   */
  const connectPhantomWallet = async () => {
    setIsConnecting(true);
    setError(null);

    try {
      const phantom = (window as any).solana;
      
      if (!phantom?.isPhantom) {
        throw new Error('Phantom Wallet not found. Please install Phantom Wallet.');
      }

      const response = await phantom.connect();
      
      if (response.publicKey) {
        setIsConnected(true);
        setWalletAddress(response.publicKey.toString());
        setWalletType('phantom');
        setNetwork('solana');
        
        console.log('Phantom Wallet connected successfully');
      } else {
        throw new Error('Failed to get public key from Phantom');
      }
    } catch (error: any) {
      console.error('Failed to connect Phantom Wallet:', error);
      setError(error.message || 'Failed to connect Phantom Wallet');
    } finally {
      setIsConnecting(false);
    }
  };

  /**
   * Disconnect wallet
   */
  const disconnectWallet = async () => {
    try {
      if (walletType === 'qnet' && window.qnet) {
        await window.qnet.disconnect();
      } else if (walletType === 'phantom') {
        const phantom = (window as any).solana;
        if (phantom) {
          await phantom.disconnect();
        }
      }
      
      handleDisconnect();
      console.log('Wallet disconnected successfully');
    } catch (error) {
      console.error('Failed to disconnect wallet:', error);
    }
  };

  /**
   * Switch network (QNet Wallet only)
   */
  const switchNetwork = async (targetNetwork: string) => {
    if (walletType !== 'qnet' || !window.qnet) return;

    try {
      if (window.qnet.switchNetwork) {
        await window.qnet.switchNetwork(targetNetwork);
      } else if (window.qnet.request) {
        // Fallback to request method
        await window.qnet.request({ 
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: targetNetwork }]
        });
      } else {
        throw new Error('Network switching not supported');
      }
      setNetwork(targetNetwork);
      await updateWalletInfo();
      console.log(`Switched to ${targetNetwork} network`);
    } catch (error) {
      console.error('Failed to switch network:', error);
      setError(`Failed to switch to ${targetNetwork} network`);
    }
  };

  /**
   * Format address for display
   */
  const formatAddress = (address: string) => {
    if (!address) return '';
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  };

  /**
   * Get wallet display name
   */
  const getWalletDisplayName = () => {
    switch (walletType) {
      case 'qnet':
        return 'QNet Wallet';
      case 'phantom':
        return 'Phantom Wallet';
      default:
        return 'Unknown Wallet';
    }
  };

  /**
   * Get network display name
   */
  const getNetworkDisplayName = () => {
    switch (network) {
      case 'solana':
        return 'Solana';
      case 'qnet':
        return 'QNet';
      case 'testnet':
        return 'Testnet';
      default:
        return network || 'Unknown';
    }
  };

  if (isConnected && walletAddress) {
    return (
      <div className="wallet-connection-container">
        <div className="wallet-info">
          <div className="wallet-header">
            <div className="wallet-badge">
              <span className="wallet-icon">
                {walletType === 'qnet' ? '💎' : '👻'}
              </span>
              <span className="wallet-name">{getWalletDisplayName()}</span>
            </div>
            <div className="network-badge">
              <span className="network-indicator"></span>
              <span className="network-name">{getNetworkDisplayName()}</span>
            </div>
          </div>
          
          <div className="wallet-details">
            <div className="wallet-address">
              <span className="address-label">Address:</span>
              <span className="address-value" title={walletAddress}>
                {formatAddress(walletAddress)}
              </span>
            </div>
            
            {balance > 0 && (
              <div className="wallet-balance">
                <span className="balance-label">Balance:</span>
                <span className="balance-value">
                  {balance.toFixed(4)} {network === 'solana' ? 'SOL' : 'QNC'}
                </span>
              </div>
            )}
          </div>

          {walletType === 'qnet' && (
            <div className="network-switcher">
              <Button
                size="sm"
                variant={network === 'solana' ? 'default' : 'outline'}
                onClick={() => switchNetwork('solana')}
                disabled={network === 'solana'}
              >
                Solana
              </Button>
              <Button
                size="sm"
                variant={network === 'qnet' ? 'default' : 'outline'}
                onClick={() => switchNetwork('qnet')}
                disabled={network === 'qnet'}
              >
                QNet
              </Button>
            </div>
          )}
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={disconnectWallet}
          className="disconnect-button"
        >
          Disconnect
        </Button>
      </div>
    );
  }

  return (
    <div className="wallet-connection-container">
      <div className="wallet-options">
        <Button
          onClick={connectQNetWallet}
          disabled={isConnecting}
          className="wallet-connect-button qnet-button"
        >
          <span className="wallet-icon">💎</span>
          <span className="wallet-text">
            {isConnecting ? 'Connecting...' : 'GET WALLET'}
          </span>
        </Button>

        <Button
          onClick={connectPhantomWallet}
          disabled={isConnecting}
          variant="outline"
          className="wallet-connect-button phantom-button"
        >
          <span className="wallet-icon">👻</span>
          <span className="wallet-text">
            {isConnecting ? 'Connecting...' : 'Connect Phantom'}
          </span>
        </Button>
      </div>

      {error && (
        <div className="wallet-error">
          <span className="error-icon">⚠️</span>
          <span className="error-message">{error}</span>
        </div>
      )}

      <div className="wallet-help">
        <p>
          <strong>Recommended:</strong> Use QNet Wallet for full dual-network support (Solana + QNet)
        </p>
        <p>
          <strong>Alternative:</strong> Use Phantom for Solana-only features
        </p>
      </div>

      <style jsx>{`
        .wallet-connection-container {
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 12px;
          padding: 20px;
          margin: 16px 0;
        }

        .wallet-info {
          margin-bottom: 16px;
        }

        .wallet-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
        }

        .wallet-badge {
          display: flex;
          align-items: center;
          gap: 8px;
          background: rgba(74, 144, 226, 0.2);
          padding: 6px 12px;
          border-radius: 20px;
        }

        .wallet-icon {
          font-size: 16px;
        }

        .wallet-name {
          font-weight: 600;
          font-size: 14px;
        }

        .network-badge {
          display: flex;
          align-items: center;
          gap: 6px;
          background: rgba(76, 175, 80, 0.2);
          padding: 4px 10px;
          border-radius: 16px;
        }

        .network-indicator {
          width: 8px;
          height: 8px;
          background: #4caf50;
          border-radius: 50%;
        }

        .network-name {
          font-size: 12px;
          font-weight: 500;
        }

        .wallet-details {
          background: rgba(255, 255, 255, 0.03);
          border-radius: 8px;
          padding: 12px;
          margin-bottom: 12px;
        }

        .wallet-address,
        .wallet-balance {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 6px;
        }

        .wallet-address:last-child,
        .wallet-balance:last-child {
          margin-bottom: 0;
        }

        .address-label,
        .balance-label {
          font-size: 12px;
          color: #888;
        }

        .address-value,
        .balance-value {
          font-size: 12px;
          font-weight: 600;
          font-family: monospace;
        }

        .network-switcher {
          display: flex;
          gap: 8px;
          margin-bottom: 12px;
        }

        .wallet-options {
          display: flex;
          flex-direction: column;
          gap: 12px;
          margin-bottom: 16px;
        }

        .wallet-connect-button {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 12px 16px;
          width: 100%;
          justify-content: center;
        }

        .qnet-button {
          background: linear-gradient(135deg, #4a90e2, #357abd);
          border: none;
        }

        .qnet-button:hover {
          background: linear-gradient(135deg, #357abd, #2a5d8f);
        }

        .phantom-button {
          border: 1px solid rgba(255, 255, 255, 0.3);
        }

        .wallet-text {
          font-weight: 600;
        }

        .disconnect-button {
          width: 100%;
        }

        .wallet-error {
          display: flex;
          align-items: center;
          gap: 8px;
          background: rgba(244, 67, 54, 0.1);
          border: 1px solid rgba(244, 67, 54, 0.3);
          border-radius: 8px;
          padding: 12px;
          margin-bottom: 16px;
        }

        .error-icon {
          font-size: 16px;
        }

        .error-message {
          font-size: 14px;
          color: #f44336;
        }

        .wallet-help {
          background: rgba(255, 255, 255, 0.03);
          border-radius: 8px;
          padding: 12px;
          font-size: 12px;
          line-height: 1.4;
        }

        .wallet-help p {
          margin-bottom: 6px;
        }

        .wallet-help p:last-child {
          margin-bottom: 0;
        }

        @media (max-width: 768px) {
          .wallet-connection-container {
            padding: 16px;
          }

          .wallet-header {
            flex-direction: column;
            gap: 8px;
            align-items: flex-start;
          }

          .wallet-details {
            padding: 10px;
          }

          .network-switcher {
            flex-direction: column;
          }
        }
      `}</style>
    </div>
  );
} 