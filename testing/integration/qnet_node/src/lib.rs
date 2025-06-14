//! QNet Node - Full blockchain node implementation

#![warn(missing_docs)]

pub mod api;
pub mod cli;
pub mod config;
pub mod error;
pub mod monitoring;
pub mod node;
pub mod sync;
pub mod validation;

pub use api::{ApiService, ApiMetrics};
pub use config::NodeConfig;
pub use error::{NodeError, NodeResult};
pub use monitoring::{MonitoringService, Alert, AlertSeverity};
pub use node::Node;
pub use validation::{MessageValidator, ValidationMetrics};

/// Node events
#[derive(Debug, Clone)]
pub enum NodeEvent {
    /// Node started
    Started,
    
    /// Node stopped
    Stopped,
    
    /// New block produced
    BlockProduced { height: u64, hash: Vec<u8> },
    
    /// Block received from network
    BlockReceived { height: u64, hash: Vec<u8> },
    
    /// Transaction received
    TransactionReceived { hash: Vec<u8> },
    
    /// Peer connected
    PeerConnected { peer_id: String },
    
    /// Peer disconnected
    PeerDisconnected { peer_id: String },
    
    /// Sync started
    SyncStarted { target_height: u64 },
    
    /// Sync completed
    SyncCompleted,
} 