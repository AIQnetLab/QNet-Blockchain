import type { 
  Block, 
  Transaction, 
  NetworkMetrics, 
  NodeInfo, 
  SystemMetrics, 
  Alert,
  SearchResult,
  ApiResponse,
  PaginatedResponse,
  ActivationRequest,
  ActivationStatus,
  SwapDetails,
  SwapRequest
} from './types';

// API Configuration - Next.js environment variables
const API_BASE_URL = typeof window !== 'undefined' 
  ? (window as any).NEXT_PUBLIC_API_URL || 'http://localhost:8000'
  : 'http://localhost:8000';

const WS_BASE_URL = typeof window !== 'undefined'
  ? (window as any).NEXT_PUBLIC_WS_URL || 'ws://localhost:8000'
  : 'ws://localhost:8000';

// API Client class
export class QNetAPI {
  private baseUrl: string;
  private wsUrl: string;

  constructor(baseUrl = API_BASE_URL, wsUrl = WS_BASE_URL) {
    this.baseUrl = baseUrl;
    this.wsUrl = wsUrl;
  }

  // Generic fetch method with error handling
  private async fetchAPI<T>(
    endpoint: string, 
    options: RequestInit = {}
  ): Promise<ApiResponse<T>> {
    try {
      const url = `${this.baseUrl}${endpoint}`;
      const response = await fetch(url, {
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
        ...options,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      return {
        success: true,
        data: data.data || data,
        message: data.message,
      };
    } catch (error) {
      // API error (silent)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // Blockchain Data Methods
  async getLatestBlocks(limit = 20): Promise<ApiResponse<Block[]>> {
    return this.fetchAPI<Block[]>(`/api/v1/blocks?limit=${limit}`);
  }

  async getBlock(identifier: string | number): Promise<ApiResponse<Block>> {
    const param = typeof identifier === 'number' ? `height=${identifier}` : `hash=${identifier}`;
    return this.fetchAPI<Block>(`/api/v1/block?${param}`);
  }

  async getTransaction(hash: string): Promise<ApiResponse<Transaction>> {
    return this.fetchAPI<Transaction>(`/api/v1/transaction/${hash}`);
  }

  async getTransactions(
    page = 1, 
    perPage = 50,
    blockIndex?: number
  ): Promise<ApiResponse<PaginatedResponse<Transaction>>> {
    let endpoint = `/api/v1/transactions?page=${page}&per_page=${perPage}`;
    if (blockIndex !== undefined) {
      endpoint += `&block=${blockIndex}`;
    }
    return this.fetchAPI<PaginatedResponse<Transaction>>(endpoint);
  }

  async searchBlockchain(query: string): Promise<ApiResponse<SearchResult[]>> {
    return this.fetchAPI<SearchResult[]>(`/api/v1/search?q=${encodeURIComponent(query)}`);
  }

  // Network Metrics
  async getNetworkMetrics(): Promise<ApiResponse<NetworkMetrics>> {
    return this.fetchAPI<NetworkMetrics>('/api/v1/metrics/network');
  }

  async getSystemMetrics(): Promise<ApiResponse<SystemMetrics>> {
    return this.fetchAPI<SystemMetrics>('/api/v1/metrics/system');
  }

  async getHistoricalMetrics(
    metric: string,
    timeRange = '24h'
  ): Promise<ApiResponse<any[]>> {
    return this.fetchAPI<any[]>(`/api/v1/metrics/historical?metric=${metric}&range=${timeRange}`);
  }

  // Node Management
  async getNodes(): Promise<ApiResponse<NodeInfo[]>> {
    return this.fetchAPI<NodeInfo[]>('/api/v1/nodes');
  }

  async getNodeInfo(nodeId: string): Promise<ApiResponse<NodeInfo>> {
    return this.fetchAPI<NodeInfo>(`/api/v1/node/${nodeId}`);
  }

  async getNodeStatus(): Promise<ApiResponse<NodeInfo>> {
    return this.fetchAPI<NodeInfo>('/api/v1/node/status');
  }

  // Alerts and Monitoring
  async getAlerts(includeResolved = false): Promise<ApiResponse<Alert[]>> {
    return this.fetchAPI<Alert[]>(`/api/v1/alerts?resolved=${includeResolved}`);
  }

  async resolveAlert(alertId: number): Promise<ApiResponse<void>> {
    return this.fetchAPI<void>(`/api/v1/alerts/${alertId}/resolve`, {
      method: 'POST',
    });
  }

  // Activation Bridge Integration
  async requestActivation(request: ActivationRequest): Promise<ApiResponse<ActivationStatus>> {
    return this.fetchAPI<ActivationStatus>('/api/v1/token/initiate_transfer', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async getActivationStatus(qnetPubkey: string): Promise<ApiResponse<ActivationStatus>> {
    return this.fetchAPI<ActivationStatus>(`/api/v1/token/status?qnet_pubkey=${qnetPubkey}`);
  }

  async verifyActivationCode(code: string): Promise<ApiResponse<any>> {
    return this.fetchAPI<any>('/api/v1/token/verify_code', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
  }

  // SWAP Operations (DEX)
  // Gas fee for swaps goes to Pool 2 (70% Super nodes, 30% Full nodes)
  
  // SWAP Operations (Internal Next.js API routes)
  // Note: These use /api/swap/* routes (internal Next.js)
  // For external backend integration, use /api/v1/swap/* paths
  
  async getSwapQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: string,
    poolAddress?: string
  ): Promise<ApiResponse<SwapDetails>> {
    const params = new URLSearchParams({
      tokenIn,
      tokenOut,
      amountIn,
    });
    if (poolAddress) params.append('pool', poolAddress);
    
    return this.fetchAPI<SwapDetails>(`/api/swap/quote?${params.toString()}`);
  }

  async executeSwap(request: SwapRequest): Promise<ApiResponse<Transaction>> {
    return this.fetchAPI<Transaction>('/api/swap/execute', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async getSwapPools(): Promise<ApiResponse<{
    pools: Array<{
      address: string;      // EON format: 19 + "eon" + 15 + 4 checksum = 41 chars
      tokenA: string;
      tokenB: string;
      reserveA: string;
      reserveB: string;
      fee: string;          // Fee percentage (goes to Pool 2: 70% Super, 30% Full)
      tvl: string;
      volume24h: string;
      apy: string;
    }>;
    totalTvl: string;
    pool2Balance: string;   // Accumulated fees for validators
  }>> {
    return this.fetchAPI('/api/swap/pools');
  }

  async getSwapHistory(
    address: string,
    page = 1,
    perPage = 20
  ): Promise<ApiResponse<PaginatedResponse<SwapDetails>>> {
    return this.fetchAPI<PaginatedResponse<SwapDetails>>(
      `/api/swap/history?address=${address}&page=${page}&per_page=${perPage}`
    );
  }

  // Admin Operations
  async getAdminDashboard(): Promise<ApiResponse<any>> {
    return this.fetchAPI<any>('/api/v1/admin/dashboard');
  }

  async restartNode(): Promise<ApiResponse<void>> {
    return this.fetchAPI<void>('/api/v1/admin/restart', {
      method: 'POST',
    });
  }

  // WebSocket Connection
  createWebSocketConnection(onMessage: (data: any) => void): WebSocket | null {
    try {
      const ws = new WebSocket(`${this.wsUrl}/ws`);
      
      ws.onopen = () => {
        /* log disabled */
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          onMessage(data);
        } catch (error) {
          /* log disabled */
        }
      };

      ws.onerror = (error) => {
        /* log disabled */
      };

      ws.onclose = () => {
        /* log disabled */
      };

      return ws;
    } catch (error) {
      /* log disabled */
      return null;
    }
  }
}

// Export singleton instance
export const qnetAPI = new QNetAPI();

// Utility function for formatting
export const formatters = {
  // Format timestamp to readable date
  formatDate: (timestamp: number): string => {
    return new Date(timestamp * 1000).toLocaleString();
  },

  // Format QNC amount
  formatQNC: (amount: number): string => {
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 6,
      maximumFractionDigits: 6,
    }).format(amount);
  },

  // Format hash with ellipsis
  formatHash: (hash: string, length = 8): string => {
    if (hash.length <= length * 2) return hash;
    return `${hash.slice(0, length)}...${hash.slice(-length)}`;
  },

  // Format duration
  formatDuration: (seconds: number): string => {
    const units = [
      { label: 'd', seconds: 86400 },
      { label: 'h', seconds: 3600 },
      { label: 'm', seconds: 60 },
      { label: 's', seconds: 1 },
    ];

    for (const unit of units) {
      const value = Math.floor(seconds / unit.seconds);
      if (value > 0) {
        return `${value}${unit.label}`;
      }
    }
    return '0s';
  },

  // Format bytes
  formatBytes: (bytes: number): string => {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(2)} ${units[unitIndex]}`;
  },
}; 
