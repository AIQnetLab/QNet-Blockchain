//! API integration for QNet node

use crate::{Node, NodeEvent};
use qnet_api::{ApiServer, ApiConfig};
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use tracing::{info, error};

/// API service for node
pub struct ApiService {
    /// Node reference
    node: Arc<Node>,
    
    /// API server
    server: Option<ApiServer>,
    
    /// Event channel
    event_tx: mpsc::UnboundedSender<NodeEvent>,
    
    /// API metrics
    metrics: Arc<RwLock<ApiMetrics>>,
}

/// API metrics
#[derive(Default, Debug, Clone)]
pub struct ApiMetrics {
    /// Total API requests
    pub total_requests: u64,
    
    /// Successful requests
    pub successful_requests: u64,
    
    /// Failed requests
    pub failed_requests: u64,
    
    /// Average response time (ms)
    pub avg_response_time: f64,
    
    /// Active connections
    pub active_connections: u32,
}

impl ApiService {
    /// Create new API service
    pub fn new(
        node: Arc<Node>,
        event_tx: mpsc::UnboundedSender<NodeEvent>,
    ) -> Self {
        Self {
            node,
            server: None,
            event_tx,
            metrics: Arc::new(RwLock::new(ApiMetrics::default())),
        }
    }
    
    /// Start API service
    pub async fn start(&mut self, config: ApiConfig) -> Result<(), Box<dyn std::error::Error>> {
        info!("Starting API service on {}", config.bind_address);
        
        // Create API server with node integration
        let server = ApiServer::new(config)
            .with_node_handler(self.create_node_handler())
            .with_metrics_handler(self.create_metrics_handler())
            .with_events_handler(self.create_events_handler());
        
        // Start server
        server.start().await?;
        
        self.server = Some(server);
        
        info!("API service started successfully");
        Ok(())
    }
    
    /// Stop API service
    pub async fn stop(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        info!("Stopping API service");
        
        if let Some(server) = self.server.take() {
            server.stop().await?;
        }
        
        info!("API service stopped");
        Ok(())
    }
    
    /// Create node handler for API
    fn create_node_handler(&self) -> impl Fn() -> NodeHandler {
        let node = self.node.clone();
        let metrics = self.metrics.clone();
        
        move || NodeHandler {
            node: node.clone(),
            metrics: metrics.clone(),
        }
    }
    
    /// Create metrics handler
    fn create_metrics_handler(&self) -> impl Fn() -> MetricsHandler {
        let node = self.node.clone();
        let api_metrics = self.metrics.clone();
        
        move || MetricsHandler {
            node: node.clone(),
            api_metrics: api_metrics.clone(),
        }
    }
    
    /// Create events handler
    fn create_events_handler(&self) -> impl Fn() -> EventsHandler {
        let event_tx = self.event_tx.clone();
        
        move || EventsHandler {
            event_tx: event_tx.clone(),
        }
    }
    
    /// Get API metrics
    pub async fn get_metrics(&self) -> ApiMetrics {
        self.metrics.read().await.clone()
    }
}

/// Handler for node-related API endpoints
pub struct NodeHandler {
    node: Arc<Node>,
    metrics: Arc<RwLock<ApiMetrics>>,
}

impl NodeHandler {
    /// Get node status
    pub async fn get_status(&self) -> Result<NodeStatus, ApiError> {
        let start = std::time::Instant::now();
        
        let result = self.node.get_status().await
            .map(|status| NodeStatus {
                version: env!("CARGO_PKG_VERSION").to_string(),
                network: "mainnet".to_string(),
                sync_status: format!("{:?}", status.sync_state),
                height: status.current_height,
                peers: status.peer_count,
                uptime: status.uptime_secs,
            })
            .map_err(|e| ApiError::Internal(e.to_string()));
        
        // Update metrics
        let mut metrics = self.metrics.write().await;
        metrics.total_requests += 1;
        if result.is_ok() {
            metrics.successful_requests += 1;
        } else {
            metrics.failed_requests += 1;
        }
        
        let response_time = start.elapsed().as_millis() as f64;
        metrics.avg_response_time = 
            (metrics.avg_response_time * (metrics.total_requests - 1) as f64 + response_time) 
            / metrics.total_requests as f64;
        
        result
    }
    
    /// Get block by height
    pub async fn get_block(&self, height: u64) -> Result<Block, ApiError> {
        self.node.get_block(height).await
            .map(|data| Block {
                height,
                hash: hex::encode(&data.hash),
                parent_hash: hex::encode(&data.parent_hash),
                timestamp: data.timestamp,
                transactions: data.transactions.len(),
            })
            .map_err(|e| ApiError::NotFound(format!("Block {} not found: {}", height, e)))
    }
    
    /// Submit transaction
    pub async fn submit_transaction(&self, tx_data: Vec<u8>) -> Result<TxResponse, ApiError> {
        self.node.submit_transaction(tx_data).await
            .map(|hash| TxResponse {
                hash: hex::encode(&hash),
                status: "pending".to_string(),
            })
            .map_err(|e| ApiError::BadRequest(e.to_string()))
    }
}

/// Handler for metrics endpoints
pub struct MetricsHandler {
    node: Arc<Node>,
    api_metrics: Arc<RwLock<ApiMetrics>>,
}

impl MetricsHandler {
    /// Get all metrics
    pub async fn get_metrics(&self) -> Result<AllMetrics, ApiError> {
        let node_metrics = self.node.get_metrics().await
            .map_err(|e| ApiError::Internal(e.to_string()))?;
        
        let api_metrics = self.api_metrics.read().await.clone();
        
        Ok(AllMetrics {
            node: node_metrics,
            api: api_metrics,
            timestamp: current_timestamp(),
        })
    }
    
    /// Get Prometheus metrics
    pub async fn get_prometheus_metrics(&self) -> Result<String, ApiError> {
        let metrics = self.get_metrics().await?;
        
        // Format as Prometheus metrics
        let mut output = String::new();
        
        // Node metrics
        output.push_str(&format!("# HELP qnet_node_height Current blockchain height\n"));
        output.push_str(&format!("# TYPE qnet_node_height gauge\n"));
        output.push_str(&format!("qnet_node_height {}\n", metrics.node.current_height));
        
        output.push_str(&format!("# HELP qnet_node_peers Connected peer count\n"));
        output.push_str(&format!("# TYPE qnet_node_peers gauge\n"));
        output.push_str(&format!("qnet_node_peers {}\n", metrics.node.peer_count));
        
        // API metrics
        output.push_str(&format!("# HELP qnet_api_requests_total Total API requests\n"));
        output.push_str(&format!("# TYPE qnet_api_requests_total counter\n"));
        output.push_str(&format!("qnet_api_requests_total {}\n", metrics.api.total_requests));
        
        output.push_str(&format!("# HELP qnet_api_response_time_ms Average response time\n"));
        output.push_str(&format!("# TYPE qnet_api_response_time_ms gauge\n"));
        output.push_str(&format!("qnet_api_response_time_ms {}\n", metrics.api.avg_response_time));
        
        Ok(output)
    }
}

/// Handler for event streaming
pub struct EventsHandler {
    event_tx: mpsc::UnboundedSender<NodeEvent>,
}

impl EventsHandler {
    /// Subscribe to events
    pub async fn subscribe(&self) -> Result<EventStream, ApiError> {
        let (tx, rx) = mpsc::unbounded_channel();
        
        // Clone event sender for forwarding
        let event_tx = self.event_tx.clone();
        
        // Spawn task to forward events
        tokio::spawn(async move {
            let mut event_rx = event_tx.subscribe();
            while let Ok(event) = event_rx.recv().await {
                if tx.send(event).is_err() {
                    break;
                }
            }
        });
        
        Ok(EventStream { rx })
    }
}

/// Event stream for WebSocket/SSE
pub struct EventStream {
    rx: mpsc::UnboundedReceiver<NodeEvent>,
}

impl EventStream {
    /// Get next event
    pub async fn next(&mut self) -> Option<NodeEvent> {
        self.rx.recv().await
    }
}

/// API response types
#[derive(Debug, serde::Serialize)]
pub struct NodeStatus {
    pub version: String,
    pub network: String,
    pub sync_status: String,
    pub height: u64,
    pub peers: usize,
    pub uptime: u64,
}

#[derive(Debug, serde::Serialize)]
pub struct Block {
    pub height: u64,
    pub hash: String,
    pub parent_hash: String,
    pub timestamp: u64,
    pub transactions: usize,
}

#[derive(Debug, serde::Serialize)]
pub struct TxResponse {
    pub hash: String,
    pub status: String,
}

#[derive(Debug, serde::Serialize)]
pub struct AllMetrics {
    pub node: NodeMetrics,
    pub api: ApiMetrics,
    pub timestamp: u64,
}

#[derive(Debug, serde::Serialize)]
pub struct NodeMetrics {
    pub current_height: u64,
    pub peer_count: usize,
    pub mempool_size: usize,
    pub tps: f64,
}

/// API errors
#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("Not found: {0}")]
    NotFound(String),
    
    #[error("Bad request: {0}")]
    BadRequest(String),
    
    #[error("Internal error: {0}")]
    Internal(String),
}

fn current_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

// Extension for Node to support API
impl Node {
    /// Get node metrics
    pub async fn get_metrics(&self) -> Result<NodeMetrics, Box<dyn std::error::Error>> {
        Ok(NodeMetrics {
            current_height: self.get_height().await?,
            peer_count: self.get_peer_count().await?,
            mempool_size: self.get_mempool_size().await?,
            tps: self.calculate_tps().await?,
        })
    }
    
    /// Calculate current TPS
    async fn calculate_tps(&self) -> Result<f64, Box<dyn std::error::Error>> {
        // In real implementation, would track transactions over time
        Ok(0.0)
    }
} 