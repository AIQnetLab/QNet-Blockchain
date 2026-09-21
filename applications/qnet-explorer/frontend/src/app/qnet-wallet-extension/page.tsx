'use client';

import React from 'react';

export default function QNetWalletExtensionPage() {
  const handleDownload = () => {
    window.open('https://chromewebstore.google.com/detail/qnet-wallet/pahnggomgmhhjjncgfnmmofmplfhkncg', '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-purple-900 to-gray-900 text-white">
      <div className="container mx-auto px-4 py-16">
        <div className="max-w-4xl mx-auto text-center">
          {/* Header */}
          <div className="mb-12">
            <h1 className="text-5xl font-bold mb-6 bg-gradient-to-r from-cyan-400 to-blue-400 bg-clip-text text-transparent">
              QNet Wallet Extension
            </h1>
            <p className="text-xl text-gray-300 max-w-2xl mx-auto">
              The QNet wallet for the browser: hold and send QNC and QNet tokens, with keys that never leave your browser. Nodes are activated from the mobile app.
            </p>
          </div>

          {/* Features Grid */}
          <div className="grid md:grid-cols-3 gap-8 mb-12">
            <div className="bg-gray-800 bg-opacity-50 p-6 rounded-lg border border-cyan-500 border-opacity-30">
              <div className="text-4xl mb-4">🔐</div>
              <h3 className="text-xl font-semibold mb-3">Secure Storage</h3>
              <p className="text-gray-300">
                Your private keys are encrypted and stored locally. Only you have access to your funds.
              </p>
            </div>

            <div className="bg-gray-800 bg-opacity-50 p-6 rounded-lg border border-cyan-500 border-opacity-30">
              <div className="text-4xl mb-4">⚡</div>
              <h3 className="text-xl font-semibold mb-3">Verified Balances</h3>
              <p className="text-gray-300">
                A balance comes with the node&apos;s account proof and is checked against the state root before it is shown.
              </p>
            </div>

            <div className="bg-gray-800 bg-opacity-50 p-6 rounded-lg border border-cyan-500 border-opacity-30">
              <div className="text-4xl mb-4">💰</div>
              <h3 className="text-xl font-semibold mb-3">Web3 Provider</h3>
              <p className="text-gray-300">
                Sites can ask the extension to connect and to sign; every request is shown to you first, and the key stays where it is.
              </p>
            </div>
          </div>

          {/* Download Section */}
          <div className="bg-gradient-to-r from-cyan-500 to-blue-500 p-8 rounded-lg mb-12">
            <h2 className="text-3xl font-bold mb-4">Download QNet Wallet</h2>
            <p className="text-lg mb-6 opacity-90">
              Available for Chrome, Edge, and other Chromium-based browsers
            </p>
            
            <button
              onClick={handleDownload}
              className="bg-white text-blue-600 font-bold py-4 px-8 rounded-lg text-lg hover:bg-gray-100 transition-colors shadow-lg"
            >
              📦 Download Extension
            </button>
            
            <div className="mt-6 text-sm opacity-75">
              <p>✅ Free • ✅ Open Source • ✅ No Registration Required</p>
            </div>
          </div>

          {/* Installation Steps */}
          <div className="bg-gray-800 bg-opacity-50 p-8 rounded-lg">
            <h2 className="text-2xl font-bold mb-6">Installation Steps</h2>
            
            <div className="grid md:grid-cols-2 gap-6 text-left">
              <div className="space-y-4">
                <div className="flex items-start space-x-3">
                  <div className="w-8 h-8 bg-cyan-500 rounded-full flex items-center justify-center text-black font-bold flex-shrink-0">1</div>
                  <div>
                    <h4 className="font-semibold">Download Extension</h4>
                    <p className="text-gray-300 text-sm">Click the download button above to get the latest version</p>
                  </div>
                </div>
                
                <div className="flex items-start space-x-3">
                  <div className="w-8 h-8 bg-cyan-500 rounded-full flex items-center justify-center text-black font-bold flex-shrink-0">2</div>
                  <div>
                    <h4 className="font-semibold">Install in Browser</h4>
                    <p className="text-gray-300 text-sm">Add to Chrome/Edge from the Web Store</p>
                  </div>
                </div>
              </div>
              
              <div className="space-y-4">
                <div className="flex items-start space-x-3">
                  <div className="w-8 h-8 bg-cyan-500 rounded-full flex items-center justify-center text-black font-bold flex-shrink-0">3</div>
                  <div>
                    <h4 className="font-semibold">Pin to Toolbar</h4>
                    <p className="text-gray-300 text-sm">Pin the extension for easy access</p>
                  </div>
                </div>
                
                <div className="flex items-start space-x-3">
                  <div className="w-8 h-8 bg-cyan-500 rounded-full flex items-center justify-center text-black font-bold flex-shrink-0">4</div>
                  <div>
                    <h4 className="font-semibold">Start Using</h4>
                    <p className="text-gray-300 text-sm">Create wallet or import existing seed phrase</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* System Requirements */}
          <div className="mt-12 text-center">
            <h3 className="text-lg font-semibold mb-4">System Requirements</h3>
            <div className="flex justify-center space-x-8 text-gray-300">
              <div>🌐 Chrome 88+</div>
              <div>🔷 Edge 88+</div>
              <div>🦊 Firefox (coming soon)</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
} 
