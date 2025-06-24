'use client';

import React from 'react';

export default function QNetWalletInstall() {
  const handleInstall = () => {
    // In production, this would link to Chrome Web Store
    // For now, show instructions
    showInstallInstructions();
  };

  const showInstallInstructions = () => {
    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50';
    modal.innerHTML = `
      <div class="bg-gray-900 border border-cyan-500 rounded-lg p-6 max-w-md mx-4 shadow-2xl">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-xl font-bold text-white">Install QNet Wallet</h3>
          <button onclick="this.closest('.fixed').remove()" class="text-gray-400 hover:text-white text-2xl">&times;</button>
        </div>
        
        <div class="space-y-4 text-gray-300">
          <div class="flex items-center space-x-3">
            <div class="w-8 h-8 bg-cyan-500 rounded-full flex items-center justify-center text-black font-bold">1</div>
            <p>Download QNet Wallet extension</p>
          </div>
          
          <div class="flex items-center space-x-3">
            <div class="w-8 h-8 bg-cyan-500 rounded-full flex items-center justify-center text-black font-bold">2</div>
            <p>Install from Chrome Web Store</p>
          </div>
          
          <div class="flex items-center space-x-3">
            <div class="w-8 h-8 bg-cyan-500 rounded-full flex items-center justify-center text-black font-bold">3</div>
            <p>Pin extension to toolbar</p>
          </div>
          
          <div class="flex items-center space-x-3">
            <div class="w-8 h-8 bg-cyan-500 rounded-full flex items-center justify-center text-black font-bold">4</div>
            <p>Refresh this page and connect</p>
          </div>
        </div>
        
        <div class="mt-6 flex space-x-3">
          <button onclick="window.open('/qnet-wallet-extension', '_blank')" class="flex-1 bg-gradient-to-r from-cyan-500 to-blue-500 text-white py-2 px-4 rounded-lg font-semibold hover:from-cyan-600 hover:to-blue-600 transition-all">
            📦 Download Extension
          </button>
          <button onclick="this.closest('.fixed').remove()" class="flex-1 bg-gray-700 text-white py-2 px-4 rounded-lg font-semibold hover:bg-gray-600 transition-all">
            Close
          </button>
        </div>
        
        <div class="mt-4 p-3 bg-blue-900 bg-opacity-50 rounded-lg">
          <p class="text-sm text-blue-200">
            💡 <strong>Tip:</strong> QNet Wallet manages both your 1DEV tokens and node activation in one place!
          </p>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    // Auto-remove after 30 seconds
    setTimeout(() => {
      if (modal.parentElement) {
        modal.remove();
      }
    }, 30000);
  };

  return (
    <div className="bg-gradient-to-r from-orange-500 to-red-500 text-white p-4 rounded-lg shadow-lg">
      <div className="flex items-center space-x-3">
        <div className="text-2xl">📦</div>
        <div className="flex-1">
          <h3 className="font-semibold">QNet Wallet Required</h3>
          <p className="text-sm opacity-90">Install the QNet Wallet extension to connect and activate nodes.</p>
        </div>
        <button
          onClick={handleInstall}
          className="bg-white text-orange-600 font-semibold py-2 px-4 rounded-lg hover:bg-gray-100 transition-colors"
        >
          Install Now
        </button>
      </div>
      
      <div className="mt-3 text-sm opacity-75">
        <p>✨ Features: 1DEV token management, one-click node activation, reward tracking</p>
      </div>
    </div>
  );
} 