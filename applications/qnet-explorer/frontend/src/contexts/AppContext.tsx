'use client';

import React, { createContext, useContext, ReactNode, useState, useEffect } from 'react';

interface QNetProvider {
  isQNet: boolean;
  version: string;
  connected: boolean;
  selectedAddress: string | null;
  networkVersion: string;
  connect(): Promise<string[]>;
  disconnect(): void;
  isConnected(): boolean;
  request(args: { method: string; params?: any[] }): Promise<any>;
  // Optional wallet-specific methods
  getBalance?(): Promise<number>;
  getNetwork?(): Promise<string>;
  switchNetwork?(network: string): Promise<void>;
  signTransaction?(tx: any): Promise<string>;
  on?(event: string, callback: Function): void;
  removeListener?(event: string, callback: Function): void;
}

interface AppContextType {
  // QNet Wallet State
  isWalletConnected: boolean;
  walletAddress: string | null;
  qnetProvider: QNetProvider | null;
  
  // Wallet Actions
  connectWallet: () => Promise<void>;
  disconnectWallet: () => void;
  
  // Node State
  nodeStatus: 'inactive' | 'activating' | 'active' | 'error';
  nodeType: 'light' | 'full' | 'super' | null;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

declare global {
  interface Window {
    qnet?: QNetProvider;
    qnetWalletReady?: boolean;
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [isWalletConnected, setIsWalletConnected] = useState(false);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [qnetProvider, setQnetProvider] = useState<QNetProvider | null>(null);
  const [nodeStatus, setNodeStatus] = useState<'inactive' | 'activating' | 'active' | 'error'>('inactive');
  const [nodeType, setNodeType] = useState<'light' | 'full' | 'super' | null>(null);

  useEffect(() => {
    // Check for QNet wallet on mount
    checkWalletStatus();

    // Listen for wallet events
    const handleWalletReady = (event: CustomEvent) => {
      setQnetProvider(event.detail.provider);
      checkWalletStatus();
    };

    const handleWalletNotFound = () => {
    };

    window.addEventListener('qnet:walletReady', handleWalletReady as EventListener);
    window.addEventListener('qnet:walletNotFound', handleWalletNotFound);

    return () => {
      window.removeEventListener('qnet:walletReady', handleWalletReady as EventListener);
      window.removeEventListener('qnet:walletNotFound', handleWalletNotFound);
    };
  }, []);

  const checkWalletStatus = () => {
    if (window.qnet && window.qnet.isQNet) {
      setQnetProvider(window.qnet);
      setIsWalletConnected(window.qnet.isConnected());
      setWalletAddress(window.qnet.selectedAddress);
    }
  };

  const connectWallet = async () => {
    if (!window.qnet) {
      throw new Error('QNet Wallet not found. Please install the extension.');
    }

    try {
      const accounts = await window.qnet.connect();
      if (accounts && accounts.length > 0) {
        setIsWalletConnected(true);
        setWalletAddress(accounts[0]);
        console.log('✅ QNet Wallet connected:', accounts[0]);
      }
    } catch (error) {
      console.error('❌ Failed to connect QNet Wallet:', error);
      throw error;
    }
  };

  const disconnectWallet = () => {
    if (window.qnet) {
      window.qnet.disconnect();
      setIsWalletConnected(false);
      setWalletAddress(null);
      setNodeStatus('inactive');
      setNodeType(null);
      console.log('🔌 QNet Wallet disconnected');
    }
  };

  const value: AppContextType = {
    // Wallet State
    isWalletConnected,
    walletAddress,
    qnetProvider,
    
    // Wallet Actions
    connectWallet,
    disconnectWallet,
    
    // Node State
    nodeStatus,
    nodeType,
  };

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext() {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('useAppContext must be used within an AppProvider');
  }
  return context;
} 