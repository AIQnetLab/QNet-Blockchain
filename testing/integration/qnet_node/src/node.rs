//! Main node implementation

use crate::{
    config::{NodeConfig, NodeType},
    error::{NodeError, NodeResult},
    sync::SyncService,
    NodeEvent,
};
use qnet_consensus::{CommitRevealConsensus, ConsensusConfig as CConfig};
use qnet_mempool::Mempool;
use qnet_p2p::{NetworkEvent, NetworkService, Keypair};
use qnet_state::StateManager;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock, Mutex};
use tracing::{debug, error, info, warn};

/// QNet Node
pub struct Node {
    /// Configuration
    config: NodeConfig,
    
    /// Network service
    network: Arc<Mutex<NetworkService>>,
    
    /// State manager
    state: Arc<StateManager>,
    
    /// Mempool
    mempool: Arc<Mempool>,
    
    /// Consensus
    consensus: Arc<Mutex<CommitRevealConsensus>>,
    
    /// Sync service
    sync: Arc<SyncService>,
    
    /// Event sender
    event_tx: broadcast::Sender<NodeEvent>,
    
    /// Running flag
    running: Arc<RwLock<bool>>,
}

impl Node {
    /// Create new node
    pub async fn new(config: NodeConfig) -> NodeResult<Self> {
        info!("Creating QNet node");
        
        // Create data directory
        std::fs::create_dir_all(&config.data_dir)?;
        
        // Load or generate keypair
        let keypair_path = config.data_dir.join("node.key");
        let keypair = if keypair_path.exists() {
            info!("Loading existing keypair");
            let key_bytes = std::fs::read(&keypair_path)?;
            Keypair::from_protobuf_encoding(&key_bytes)
                .map_err(|e| NodeError::Config(format!("Invalid keypair: {}", e)))?
        } else {
            info!("Generating new keypair");
            let keypair = Keypair::generate_ed25519();
            std::fs::write(&keypair_path, keypair.to_protobuf_encoding().unwrap())?;
            keypair
        };
        
        // Create network service
        let network = Arc::new(Mutex::new(
            NetworkService::new(config.network.clone(), keypair)?
        ));
        
        // Create state manager
        let state_path = config.data_dir.join("state");
        let state = Arc::new(StateManager::new(&state_path)?);
        
        // Create mempool
        let mempool = Arc::new(Mempool::new());
        
        // Create consensus
        let consensus_config = CConfig {
            commit_phase_ms: config.consensus.block_time_ms / 2,
            reveal_phase_ms: config.consensus.block_time_ms / 2,
            reputation_threshold: 50.0,  // FIXED: 0-100 scale
            max_validators: 100,
        };
        let consensus = Arc::new(Mutex::new(
            CommitRevealConsensus::new(consensus_config)
        ));
        
        // Create sync service
        let sync = Arc::new(SyncService::new(
            state.clone(),
            network.clone(),
        ));
        
        let (event_tx, _) = broadcast::channel(1000);
        
        Ok(Self {
            config,
            network,
            state,
            mempool,
            consensus,
            sync,
            event_tx,
            running: Arc::new(RwLock::new(false)),
        })
    }
    
    /// Start the node
    pub async fn start(&self) -> NodeResult<()> {
        let mut running = self.running.write().await;
        if *running {
            return Err(NodeError::AlreadyRunning);
        }
        
        info!("Starting QNet node");
        
        // Start network
        let network = self.network.clone();
        let network_events = {
            let net = network.lock().await;
            net.subscribe()
        };
        
        tokio::spawn(async move {
            let mut net = network.lock().await;
            if let Err(e) = net.start().await {
                error!("Network error: {}", e);
            }
        });
        
        // Start network event handler
        let event_tx = self.event_tx.clone();
        let mempool = self.mempool.clone();
        let sync = self.sync.clone();
        
        tokio::spawn(async move {
            Self::handle_network_events(
                network_events,
                event_tx,
                mempool,
                sync,
            ).await;
        });
        
        // Start consensus if producer
        if self.config.consensus.enable_producer {
            self.start_consensus().await?;
        }
        
        // Start API if enabled
        if self.config.api.enabled {
            self.start_api().await?;
        }
        
        *running = true;
        let _ = self.event_tx.send(NodeEvent::Started);
        
        Ok(())
    }
    
    /// Handle network events
    async fn handle_network_events(
        mut events: broadcast::Receiver<NetworkEvent>,
        event_tx: broadcast::Sender<NodeEvent>,
        mempool: Arc<Mempool>,
        sync: Arc<SyncService>,
    ) {
        while let Ok(event) = events.recv().await {
            match event {
                NetworkEvent::PeerConnected(peer) => {
                    info!("Peer connected: {}", peer);
                    let _ = event_tx.send(NodeEvent::PeerConnected {
                        peer_id: peer.to_string(),
                    });
                }
                
                NetworkEvent::PeerDisconnected(peer) => {
                    info!("Peer disconnected: {}", peer);
                    let _ = event_tx.send(NodeEvent::PeerDisconnected {
                        peer_id: peer.to_string(),
                    });
                }
                
                NetworkEvent::NewBlock(data) => {
                    debug!("New block received");
                    // TODO: Validate and process block
                    let _ = event_tx.send(NodeEvent::BlockReceived {
                        height: 0, // TODO: Parse from block
                        hash: data[..32].to_vec(),
                    });
                }
                
                NetworkEvent::NewTransaction(data) => {
                    debug!("New transaction received");
                    // Add to mempool
                    if let Err(e) = mempool.add_transaction(data.clone()).await {
                        warn!("Failed to add transaction to mempool: {}", e);
                    } else {
                        let _ = event_tx.send(NodeEvent::TransactionReceived {
                            hash: data[..32].to_vec(),
                        });
                    }
                }
                
                NetworkEvent::SyncRequest { peer, from_height } => {
                    debug!("Sync request from {} at height {}", peer, from_height);
                    // Handle sync request
                    sync.handle_sync_request(peer, from_height).await;
                }
            }
        }
    }
    
    /// Start consensus
    async fn start_consensus(&self) -> NodeResult<()> {
        info!("Starting consensus");
        
        let consensus = self.consensus.clone();
        let mempool = self.mempool.clone();
        let state = self.state.clone();
        let network = self.network.clone();
        let event_tx = self.event_tx.clone();
        let block_time = self.config.consensus.block_time_ms;
        
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(
                std::time::Duration::from_millis(block_time)
            );
            
            loop {
                interval.tick().await;
                
                // Get transactions from mempool
                let txs = mempool.get_transactions(100).await;
                
                // Create block
                let height = state.get_height().await.unwrap_or(0) + 1;
                let block_data = format!("block_{}_txs_{}", height, txs.len());
                
                // Run consensus
                let mut consensus = consensus.lock().await;
                match consensus.propose_block(block_data.as_bytes()).await {
                    Ok(hash) => {
                        info!("Block proposed: height={}, hash={:?}", height, hash);
                        
                        // Broadcast block
                        let mut net = network.lock().await;
                        if let Err(e) = net.broadcast_block(hash.clone()) {
                            error!("Failed to broadcast block: {}", e);
                        }
                        
                        let _ = event_tx.send(NodeEvent::BlockProduced {
                            height,
                            hash,
                        });
                    }
                    Err(e) => {
                        warn!("Consensus error: {}", e);
                    }
                }
            }
        });
        
        Ok(())
    }
    
    /// Start API server
    async fn start_api(&self) -> NodeResult<()> {
        info!("Starting API server on {}", self.config.api.listen_addr);
        
        // TODO: Integrate with qnet-api
        
        Ok(())
    }
    
    /// Stop the node
    pub async fn stop(&self) -> NodeResult<()> {
        let mut running = self.running.write().await;
        if !*running {
            return Err(NodeError::NotRunning);
        }
        
        info!("Stopping QNet node");
        
        *running = false;
        let _ = self.event_tx.send(NodeEvent::Stopped);
        
        Ok(())
    }
    
    /// Subscribe to node events
    pub fn subscribe(&self) -> broadcast::Receiver<NodeEvent> {
        self.event_tx.subscribe()
    }
    
    /// Get node info
    pub async fn info(&self) -> NodeResult<NodeInfo> {
        let running = *self.running.read().await;
        let height = self.state.get_height().await?;
        let peers = {
            let net = self.network.lock().await;
            net.connected_peers().await.len()
        };
        let mempool_size = self.mempool.size().await;
        
        Ok(NodeInfo {
            running,
            node_type: self.config.node_type,
            height,
            peers,
            mempool_size,
        })
    }
}

/// Node information
#[derive(Debug, Clone)]
pub struct NodeInfo {
    /// Is running
    pub running: bool,
    
    /// Node type
    pub node_type: NodeType,
    
    /// Current height
    pub height: u64,
    
    /// Connected peers
    pub peers: usize,
    
    /// Mempool size
    pub mempool_size: usize,
} 