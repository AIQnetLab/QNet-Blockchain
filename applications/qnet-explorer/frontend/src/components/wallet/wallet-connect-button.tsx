'use client';

import { useState, useEffect } from 'react';

// Use flexible typing for QNet provider to avoid conflicts
interface QNetWalletProvider {
  connect: () => Promise<string[]>;
  disconnect?: () => Promise<void> | void;
  isConnected?: () => boolean;
  request?: (args: any) => Promise<any>;
  on?: (event: string, handler: (...args: any[]) => void) => void;
  removeListener?: (event: string, handler: (...args: any[]) => void) => void;
}

const WalletConnectButton = () => {
  const [isConnected, setIsConnected] = useState(false);
  const [account, setAccount] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [qnetProvider, setQnetProvider] = useState<QNetWalletProvider | null>(null);
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
  }, []);

  useEffect(() => {
    if (!isClient) return;

    const provider = (window as any).qnet as QNetWalletProvider | undefined;
    if (provider) {
      setQnetProvider(provider);
    }

    const checkConnection = async () => {
      if (provider?.isConnected && provider.isConnected()) {
        try {
          const accounts = await provider.connect();
          if (accounts && accounts.length > 0) {
            setAccount(accounts[0]);
            setIsConnected(true);
          } else {
            setAccount(null);
            setIsConnected(false);
          }
        } catch {
            setAccount(null);
            setIsConnected(false);
        }
      } else {
        setAccount(null);
        setIsConnected(false);
      }
    };

    checkConnection();

    const handleAccountsChanged = () => checkConnection();
    
    // Listen for wallet events if possible
    if(provider?.on) {
        provider.on('accountsChanged', handleAccountsChanged);
    }

    // Fallback polling for provider injection and connection status
    const interval = setInterval(() => {
      const currentProvider = (window as any).qnet;
      if (!qnetProvider && currentProvider) {
        setQnetProvider(currentProvider);
      }
      checkConnection();
    }, 3000);

    return () => {
      clearInterval(interval);
      if (provider?.removeListener) {
        provider.removeListener('accountsChanged', handleAccountsChanged);
      }
    };
  }, [isClient, qnetProvider]);

  const connectWallet = async () => {
    if (!qnetProvider) {
      // This should ideally not be reached if install button is shown
      installQNetWallet();
      return;
    }

    setIsConnecting(true);
    try {
      const accounts = await qnetProvider.connect();
      if (accounts && accounts.length > 0) {
        setAccount(accounts[0]);
        setIsConnected(true);
        console.log('✅ Wallet connected:', accounts[0]);
      }
    } catch (error) {
      console.error('❌ Failed to connect wallet:', error);
      alert('Failed to connect wallet. Please try again.');
    } finally {
      setIsConnecting(false);
    }
  };

  const disconnectWallet = async () => {
    if (qnetProvider?.disconnect) {
      try {
        await qnetProvider.disconnect();
        setAccount(null);
        setIsConnected(false);
      } catch (error) {
        console.error('Failed to disconnect wallet:', error);
      }
    }
  };

  const installQNetWallet = () => {
    window.open('https://chromewebstore.google.com/detail/qnet-wallet/pahnggomgmhhjjncgfnmmofmplfhkncg?hl=en-US&utm_source=ext_sidebar', '_blank');
  };

  const formatAddress = (address: string) => {
    if (!address || address.length <= 10) return address;
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  };
  
  if (!isClient) {
    return (
      <button disabled className="qnet-button">
        Loading...
      </button>
    );
  }

  if (!qnetProvider) {
    return (
      <button
        onClick={installQNetWallet}
        className="qnet-button install-button"
      >
        GET WALLET
      </button>
    );
  }

  if (isConnected && account) {
    return (
      <div className="wallet-connected-container">
        <div className="wallet-account-info">
          🟢 {formatAddress(account)}
        </div>
        <button
          onClick={disconnectWallet}
          className="qnet-button disconnect-button"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={connectWallet}
      disabled={isConnecting}
      className="qnet-button"
    >
      GET WALLET
    </button>
  );
}

export default WalletConnectButton; 