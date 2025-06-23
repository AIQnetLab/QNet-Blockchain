'use client';

import React from 'react';

export default function Navigation() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-black/80 backdrop-blur-sm border-b border-cyan-500/20">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          <div className="text-cyan-400 font-bold text-xl">QNET</div>
          <div className="flex space-x-6">
            <a href="#" className="text-cyan-400 hover:text-cyan-300 transition-colors">Home</a>
            <a href="#" className="text-cyan-400 hover:text-cyan-300 transition-colors">Explorer</a>
            <a href="#" className="text-cyan-400 hover:text-cyan-300 transition-colors">Nodes</a>
            <a href="#" className="text-cyan-400 hover:text-cyan-300 transition-colors">Wallet</a>
          </div>
        </div>
      </div>
    </nav>
  );
}