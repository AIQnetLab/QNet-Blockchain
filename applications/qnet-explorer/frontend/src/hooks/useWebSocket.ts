'use client';

import { useEffect, useState, useCallback, useRef } from 'react';

// WebSocket event types from QNet node
export interface WsNewBlock {
  type: 'new_block';
  data: {
    height: number;
    hash: string;
    timestamp: number;
    tx_count: number;
    producer: string;
  };
}

export interface WsPendingTx {
  type: 'pending_tx';
  data: {
    hash: string;
    from: string;
    to: string | null;
    amount: number;
    gas_price: number;
  };
}

export interface WsRewardClaimed {
  type: 'reward_claimed';
  data: {
    node_id: string;
    wallet_address: string;
    amount_qnc: number;
    tx_hash: string;
    epoch: number;
  };
}

export interface WsConnected {
  type: 'connected';
  message: string;
  subscribed_channels: number;
  timestamp: number;
}

export type WsEvent = WsNewBlock | WsPendingTx | WsRewardClaimed | WsConnected;

interface UseWebSocketOptions {
  url: string;
  channels?: string[];
  onMessage?: (event: WsEvent) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Event) => void;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

interface UseWebSocketResult {
  isConnected: boolean;
  lastEvent: WsEvent | null;
  lastBlock: WsNewBlock['data'] | null;
  pendingTxCount: number;
  reconnect: () => void;
}

/**
 * React hook for real-time WebSocket connection to QNet node
 * 
 * @example
 * ```tsx
 * const { isConnected, lastBlock, pendingTxCount } = useWebSocket({
 *   url: 'ws://localhost:8001/ws/subscribe',
 *   channels: ['blocks', 'mempool'],
 *   onMessage: (event) => console.log('New event:', event),
 * });
 * ```
 */
export function useWebSocket({
  url,
  channels = ['blocks'],
  onMessage,
  onConnect,
  onDisconnect,
  onError,
  reconnectInterval = 5000,
  maxReconnectAttempts = 10,
}: UseWebSocketOptions): UseWebSocketResult {
  const [isConnected, setIsConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<WsEvent | null>(null);
  const [lastBlock, setLastBlock] = useState<WsNewBlock['data'] | null>(null);
  const [pendingTxCount, setPendingTxCount] = useState(0);
  
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const connect = useCallback(() => {
    // Build URL with channels query param
    const channelsParam = channels.join(',');
    const wsUrl = `${url}?channels=${channelsParam}`;
    
    console.log('[WS] Connecting to:', wsUrl);
    
    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      
      ws.onopen = () => {
        console.log('[WS] ✅ Connected');
        setIsConnected(true);
        reconnectAttemptsRef.current = 0;
        onConnect?.();
      };
      
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as WsEvent;
          setLastEvent(data);
          
          // Handle specific event types
          if (data.type === 'new_block') {
            setLastBlock((data as WsNewBlock).data);
            // Clear pending TX count when new block arrives (they're now confirmed)
            setPendingTxCount(0);
          } else if (data.type === 'pending_tx') {
            setPendingTxCount((prev) => prev + 1);
          }
          
          onMessage?.(data);
        } catch (e) {
          console.error('[WS] Failed to parse message:', e);
        }
      };
      
      ws.onclose = () => {
        console.log('[WS] 🔌 Disconnected');
        setIsConnected(false);
        wsRef.current = null;
        onDisconnect?.();
        
        // Attempt reconnection
        if (reconnectAttemptsRef.current < maxReconnectAttempts) {
          reconnectAttemptsRef.current += 1;
          console.log(`[WS] Reconnecting in ${reconnectInterval}ms (attempt ${reconnectAttemptsRef.current}/${maxReconnectAttempts})`);
          
          reconnectTimeoutRef.current = setTimeout(() => {
            connect();
          }, reconnectInterval);
        } else {
          console.error('[WS] Max reconnect attempts reached');
        }
      };
      
      ws.onerror = (error) => {
        console.error('[WS] ❌ Error:', error);
        onError?.(error);
      };
    } catch (e) {
      console.error('[WS] Failed to create WebSocket:', e);
    }
  }, [url, channels, onMessage, onConnect, onDisconnect, onError, reconnectInterval, maxReconnectAttempts]);

  const reconnect = useCallback(() => {
    // Clear any pending reconnect
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    
    // Close existing connection
    if (wsRef.current) {
      wsRef.current.close();
    }
    
    // Reset attempts and connect
    reconnectAttemptsRef.current = 0;
    connect();
  }, [connect]);

  // Connect on mount
  useEffect(() => {
    connect();
    
    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect]);

  return {
    isConnected,
    lastEvent,
    lastBlock,
    pendingTxCount,
    reconnect,
  };
}

/**
 * Get WebSocket URL from backend URL
 */
export function getWebSocketUrl(backendUrl: string): string {
  return backendUrl
    .replace('http://', 'ws://')
    .replace('https://', 'wss://')
    + '/ws/subscribe';
}

