'use client';

import React, { useEffect, useState } from 'react';
import { useWebSocket, getWebSocketUrl, WsEvent, WsNewBlock } from '../hooks/useWebSocket';

interface RealTimeStatusProps {
  backendUrl: string;
  onNewBlock?: (block: WsNewBlock['data']) => void;
  onNewTransaction?: (hash: string) => void;
}

/**
 * Real-time connection status indicator with WebSocket integration
 * 
 * Displays:
 * - Connection status (green/red dot)
 * - Live block height updates
 * - Pending transaction count
 * - Last block info (producer, tx count)
 */
export function RealTimeStatus({ backendUrl, onNewBlock, onNewTransaction }: RealTimeStatusProps) {
  const [notifications, setNotifications] = useState<Array<{ id: number; message: string; type: 'block' | 'tx' }>>([]);
  
  const { isConnected, lastBlock, pendingTxCount } = useWebSocket({
    url: getWebSocketUrl(backendUrl),
    channels: ['blocks', 'mempool'],
    onMessage: (event: WsEvent) => {
      if (event.type === 'new_block') {
        const block = (event as WsNewBlock).data;
        onNewBlock?.(block);
        
        // Add notification
        const id = Date.now();
        setNotifications(prev => [
          ...prev.slice(-4), // Keep last 5
          { 
            id, 
            message: `Block #${block.height} (${block.tx_count} tx)`, 
            type: 'block' as const 
          }
        ]);
        
        // Remove after 3 seconds
        setTimeout(() => {
          setNotifications(prev => prev.filter(n => n.id !== id));
        }, 3000);
      } else if (event.type === 'pending_tx') {
        onNewTransaction?.((event as any).data.hash);
      }
    },
  });

  return (
    <div className="fixed bottom-4 right-4 z-50">
      {/* Connection status badge */}
      <div className={`
        flex items-center gap-2 px-3 py-2 rounded-lg shadow-lg backdrop-blur-sm
        ${isConnected 
          ? 'bg-green-500/20 border border-green-500/50' 
          : 'bg-red-500/20 border border-red-500/50'}
      `}>
        {/* Status dot */}
        <span className={`
          w-2 h-2 rounded-full animate-pulse
          ${isConnected ? 'bg-green-400' : 'bg-red-400'}
        `} />
        
        {/* Status text */}
        <span className="text-xs font-medium text-white/80">
          {isConnected ? 'LIVE' : 'OFFLINE'}
        </span>
        
        {/* Block height */}
        {lastBlock && (
          <span className="text-xs text-white/60 ml-2">
            #{lastBlock.height.toLocaleString()}
          </span>
        )}
        
        {/* Pending TX count */}
        {pendingTxCount > 0 && (
          <span className="text-xs bg-yellow-500/30 text-yellow-200 px-1.5 py-0.5 rounded">
            {pendingTxCount} pending
          </span>
        )}
      </div>
      
      {/* Notifications stack */}
      <div className="mt-2 space-y-1">
        {notifications.map(n => (
          <div
            key={n.id}
            className={`
              text-xs px-3 py-1.5 rounded-lg shadow-lg backdrop-blur-sm
              animate-slide-in
              ${n.type === 'block' 
                ? 'bg-blue-500/20 border border-blue-500/30 text-blue-200' 
                : 'bg-purple-500/20 border border-purple-500/30 text-purple-200'}
            `}
          >
            {n.type === 'block' ? '📦' : '📨'} {n.message}
          </div>
        ))}
      </div>
    </div>
  );
}

// Add CSS animation for notifications
const styles = `
@keyframes slide-in {
  from {
    opacity: 0;
    transform: translateX(100%);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

.animate-slide-in {
  animation: slide-in 0.3s ease-out;
}
`;

// Inject styles on mount
if (typeof document !== 'undefined') {
  const styleElement = document.createElement('style');
  styleElement.textContent = styles;
  document.head.appendChild(styleElement);
}

