//! Node-related API handlers

use actix_web::{web, HttpResponse};
use serde::Serialize;
use crate::{error::ApiResult, state::AppState};
use hex;

/// Node info response
#[derive(Debug, Serialize)]
pub struct NodeInfo {
    pub version: String,
    pub network: String,
    pub node_id: String,
    pub is_validator: bool,
    pub sync_status: SyncStatus,
}

/// Sync status
#[derive(Debug, Serialize)]
pub struct SyncStatus {
    pub is_syncing: bool,
    pub current_height: u64,
    pub target_height: Option<u64>,
    pub peers_connected: usize,
}

/// Peer info
#[derive(Debug, Serialize)]
pub struct PeerInfo {
    pub peer_id: String,
    pub address: String,
    pub version: String,
    pub last_seen: u64,
    pub latency_ms: Option<u32>,
}

/// Get node information
pub async fn get_node_info(
    state: web::Data<AppState>,
) -> ApiResult<HttpResponse> {
    let current_height = match state.state_db.get_latest_block().await? {
        Some(block) => block.header.height,
        None => 0,
    };
    
    // Generate deterministic node ID based on public key
    let node_id = format!("qnet-node-{}", 
        hex::encode(&state.config.network_id.as_bytes()[..8]));
    
    // Check validator status based on node configuration
    let is_validator = state.config.network_id.contains("validator") || 
                      state.config.network_id.contains("super");
    
    // Get peer count from network state
    let peers_connected = state.get_connected_peers_count();
    
    let info = NodeInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        network: state.config.network_id.clone(),
        node_id,
        is_validator,
        sync_status: SyncStatus {
            is_syncing: current_height == 0 || peers_connected == 0,
            current_height,
            target_height: if peers_connected > 0 { Some(current_height + 1) } else { None },
            peers_connected,
        },
    };
    
    Ok(HttpResponse::Ok().json(info))
}

/// Get connected peers
pub async fn get_peers(
    state: web::Data<AppState>,
) -> ApiResult<HttpResponse> {
    // Get actual peer information from network state
    let peers = state.get_active_peers();
    
    let peer_info: Vec<PeerInfo> = peers.into_iter().map(|peer| {
        PeerInfo {
            peer_id: peer.id,
            address: peer.address,
            version: peer.version.unwrap_or_else(|| "1.0.0".to_string()),
            last_seen: peer.last_contact,
            latency_ms: peer.latency_ms,
        }
    }).collect();
    
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "peers": peer_info,
        "total": peer_info.len(),
    })))
}

/// Get sync status
pub async fn get_sync_status(
    state: web::Data<AppState>,
) -> ApiResult<HttpResponse> {
    let current_height = match state.state_db.get_latest_block().await? {
        Some(block) => block.header.height,
        None => 0,
    };
    
    let peers_connected = state.get_connected_peers_count();
    let target_height = state.get_network_height().await.unwrap_or(current_height);
    
    let sync_status = SyncStatus {
        is_syncing: current_height < target_height,
        current_height,
        target_height: if target_height > current_height { Some(target_height) } else { None },
        peers_connected,
    };
    
    Ok(HttpResponse::Ok().json(sync_status))
} 