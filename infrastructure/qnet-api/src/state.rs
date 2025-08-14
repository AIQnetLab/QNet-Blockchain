//! Application state

use crate::config::Config;
use qnet_state::StateDB;
use qnet_mempool::Mempool;
use qnet_consensus::{CommitRevealConsensus, ConsensusConfig};
use std::sync::Arc;
use std::path::Path;

/// Application state shared across handlers
pub struct AppState {
    /// State database
    pub state_db: Arc<StateDB>,
    
    /// Transaction mempool
    pub mempool: Arc<Mempool>,
    
    /// Consensus mechanism
    pub consensus: Arc<CommitRevealConsensus>,
    
    /// Configuration
    pub config: Config,
}

impl AppState {
    /// Create new application state
    pub async fn new(config: &Config) -> Result<Self, Box<dyn std::error::Error>> {
        // Initialize state database
        let state_db = Arc::new(StateDB::with_sled(Path::new(&config.state_db_path))?);
        
        // Initialize mempool
        let mempool_config = qnet_mempool::mempool::MempoolConfig::default();
        let mempool = Arc::new(Mempool::new(mempool_config, Arc::clone(&state_db)));
        
        // Initialize consensus
        let consensus_config = ConsensusConfig::default();
        let node_id = "api-node".to_string(); // API server node identifier
        let consensus = Arc::new(CommitRevealConsensus::new(node_id, consensus_config));
        
        Ok(Self {
            state_db,
            mempool,
            consensus,
            config: config.clone(),
        })
    }


} 