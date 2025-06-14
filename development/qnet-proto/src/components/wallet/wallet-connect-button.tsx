'use client';

import React, { useState } from 'react';
import { Button } from '../ui/button';

export default function WalletConnectButton() {
  const [isConnecting, setIsConnecting] = useState(false);
  const [qnetWalletConnected, setQnetWalletConnected] = useState(false);

  const handleConnectQNetWallet = async () => {
    setIsConnecting(true);
    try {
      // Open QNet wallet directly - much simpler!
      await openQNetWallet();
      setQnetWalletConnected(true);
    } catch (error) {
      console.error('ERROR Failed to open QNet wallet:', error);
      showErrorNotification('Failed to connect QNet wallet');
    }
    setIsConnecting(false);
  };

  const openQNetWallet = async () => {
    try {
      // Direct QNet wallet opening with import option
      const qnetWalletUrl = chrome.runtime.getURL('popup.html#connect');
      await chrome.tabs.create({ 
        url: qnetWalletUrl,
        active: true 
      });
      
      console.log('SUCCESS QNet wallet opened');
      
      // Show connection instructions
      showConnectionInstructions();
    } catch (error) {
      console.error('ERROR Failed to open QNet wallet:', error);
      // Fallback for non-extension environments
      window.open('/qnet-wallet/popup.html#connect', '_blank');
    }
  };

  const showConnectionInstructions = () => {
    const notification = document.createElement('div');
    notification.innerHTML = `
      <div style="position: fixed; top: 20px; right: 20px; background: linear-gradient(135deg, #7c3aed, #06b6d4); color: white; padding: 20px; border-radius: 12px; z-index: 10000; max-width: 350px; box-shadow: 0 10px 30px rgba(0,0,0,0.3);">
        <h4 style="margin: 0 0 12px 0; font-weight: 600;">QNet Wallet Instructions</h4>
        <ol style="margin: 0; padding-left: 20px; font-size: 14px; line-height: 1.6;">
          <li>Buy 1DEV tokens on any Solana DEX</li>
          <li>In QNet wallet: Import → Paste your Solana seed phrase</li>
          <li>QNet wallet will auto-filter to show only 1DEV tokens</li>
          <li>Go to Node tab → Select node type → One-click activate</li>
          <li>Done! Start earning rewards every 4 hours</li>
        </ol>
        <button onclick="this.parentElement.parentElement.remove()" style="position: absolute; top: 8px; right: 12px; background: none; border: none; color: white; cursor: pointer; font-size: 18px;">&times;</button>
      </div>
    `;
    document.body.appendChild(notification);
    
    setTimeout(() => {
      if (notification.parentElement) {
        notification.remove();
      }
    }, 15000); // 15 seconds
  };

  const showErrorNotification = (message) => {
    const notification = document.createElement('div');
    notification.innerHTML = `
      <div style="position: fixed; top: 20px; right: 20px; background: #ef4444; color: white; padding: 16px; border-radius: 8px; z-index: 10000; max-width: 300px;">
        <h4 style="margin: 0 0 8px 0; font-weight: 600;">Connection Error</h4>
        <p style="margin: 0; font-size: 14px;">${message}</p>
        <button onclick="this.parentElement.parentElement.remove()" style="position: absolute; top: 8px; right: 8px; background: none; border: none; color: white; cursor: pointer;">&times;</button>
      </div>
    `;
    document.body.appendChild(notification);
    
    setTimeout(() => {
      if (notification.parentElement) {
        notification.remove();
      }
    }, 5000);
  };

  const handleDisconnect = () => {
    setQnetWalletConnected(false);
  };

  return (
    <div className="relative">
      <Button
        variant="quantum-primary"
        className="font-medium"
        disabled={isConnecting}
        onClick={() => {
          if (qnetWalletConnected) {
            handleDisconnect();
          } else {
            handleConnectQNetWallet();
          }
        }}
      >
        {isConnecting ? (
          <div className="flex items-center">
            <svg className="animate-spin -ml-1 mr-3 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            Opening QNet Wallet...
          </div>
        ) : qnetWalletConnected ? (
          <span className="flex items-center">
            SUCCESS QNet Wallet Connected
          </span>
        ) : (
          <span>CONNECT QNet Wallet</span>
        )}
      </Button>

      {/* Status indicator */}
      {qnetWalletConnected && (
        <div className="absolute -top-2 -right-2">
          <div className="w-4 h-4 rounded-full bg-green-500 animate-pulse"></div>
        </div>
      )}
    </div>
  );
}
