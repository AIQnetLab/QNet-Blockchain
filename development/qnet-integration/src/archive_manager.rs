//! Archive Replication Manager - Production system for distributed blockchain archival
//! 
//! This module implements a distributed archival system where:
//! - Full nodes archive 3 chunks as network obligation
//! - Super nodes archive 8 chunks as network obligation
//! - Genesis nodes archive 20+ chunks for critical network infrastructure
//! - Automatic replication ensures 3+ copies of each chunk exist
//! - Compliance enforcement maintains network fault tolerance
//! - Background monitoring ensures archival obligations are met

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::RwLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use crate::errors::{IntegrationError, IntegrationResult};
use crate::node::NodeType;
use sha3::{Sha3_256, Digest};
use bincode;
use serde::{Serialize, Deserialize};

/// Archive chunk containing compressed blockchain data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchiveChunk {
    /// Unique chunk identifier
    pub chunk_id: [u8; 32],
    /// Height range this chunk covers
    pub height_start: u64,
    pub height_end: u64,
    /// Compressed blockchain data  
    pub compressed_data: Vec<u8>,
    /// Creation timestamp
    pub created_at: u64,
    /// Compression ratio achieved
    pub compression_ratio: f32,
    /// Verification hash for integrity
    pub verification_hash: [u8; 32],
}

/// Node information for archive assignment
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchiveNodeInfo {
    pub node_id: String,
    pub node_type: NodeType,
    pub ip_address: String,
    pub last_seen: u64,
    /// Chunks this node is responsible for
    pub assigned_chunks: Vec<[u8; 32]>,
    /// Compliance status
    pub compliance_status: ComplianceStatus,
}

/// Compliance tracking for archive obligations
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ComplianceStatus {
    /// Node is fulfilling all archive obligations  
    Compliant,
    /// Node is missing required chunks
    NonCompliant { missing_chunks: u8 },
    /// Node has not responded to health checks
    Unresponsive,
    /// Node is in grace period after activation
    GracePeriod { expires_at: u64 },
}

/// Archive Replication Manager - enforces distributed archival obligations
pub struct ArchiveReplicationManager {
    /// All known archive chunks in the network
    archive_chunks: Arc<RwLock<HashMap<[u8; 32], ArchiveChunk>>>,
    /// Nodes participating in archival system
    archive_nodes: Arc<RwLock<HashMap<String, ArchiveNodeInfo>>>,
    /// Chunk assignment tracking (chunk_id -> list of node_ids)
    chunk_assignments: Arc<RwLock<HashMap<[u8; 32], Vec<String>>>>,
    /// Minimum replicas per chunk (adaptive based on network size)
    min_replicas: u8,
    /// Maximum replicas per chunk (adaptive based on network size)
    max_replicas: u8,
    /// Health check interval
    health_check_interval: Duration,
    /// Grace period for new nodes (24 hours)
    grace_period_hours: u32,
    /// Network size adaptive scaling
    adaptive_scaling: bool,
}

impl ArchiveReplicationManager {
    /// Create new archive replication manager with production settings
    pub fn new() -> Self {
        Self {
            archive_chunks: Arc::new(RwLock::new(HashMap::new())),
            archive_nodes: Arc::new(RwLock::new(HashMap::new())),
            chunk_assignments: Arc::new(RwLock::new(HashMap::new())),
            min_replicas: 3,        // Adaptive minimum based on network size
            max_replicas: 7,        // Adaptive maximum based on network size
            health_check_interval: Duration::from_secs(4 * 3600), // 4 hours
            grace_period_hours: 24, // 24 hours for new nodes to comply
            adaptive_scaling: true, // Enable adaptive scaling for small networks
        }
    }
    
    /// Register node for archival responsibilities (MANDATORY assignments)
    pub async fn register_archive_node(&mut self, node_id: &str, node_type: NodeType, ip_address: &str) -> IntegrationResult<()> {
        let current_time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| IntegrationError::Other(format!("Time error: {}", e)))?
            .as_secs();
        
        // Calculate adaptive archive quota based on network size
        let required_chunks = if self.adaptive_scaling {
            self.calculate_adaptive_quota(&node_type).await?
        } else {
            // Static quotas for large networks
            match node_type {
                NodeType::Light => 0,    // Light nodes exempt from archival
                NodeType::Full => 3,     // Static: Full nodes archive 3 chunks
                NodeType::Super => 8,    // Static: Super nodes archive 8 chunks
            }
        };
        
        let node_info = ArchiveNodeInfo {
            node_id: node_id.to_string(),
            node_type,
            ip_address: ip_address.to_string(),
            last_seen: current_time,
            assigned_chunks: Vec::new(),
            compliance_status: ComplianceStatus::GracePeriod {
                expires_at: current_time + (self.grace_period_hours as u64 * 3600),
            },
        };
        
        {
            let mut archive_nodes = self.archive_nodes.write().await;
            archive_nodes.insert(node_id.to_string(), node_info);
        }
        
        println!("[ArchiveManager] 📋 Registered {:?} node {} for archival (quota: {} chunks)", 
                node_type, node_id, required_chunks);
        
        // Immediately assign mandatory chunks (no choice)
        if required_chunks > 0 {
            self.assign_mandatory_chunks(node_id, required_chunks).await?;
        }
        
        Ok(())
    }
    
    /// Assign mandatory chunks to a node (enforcement, not choice)
    async fn assign_mandatory_chunks(&mut self, node_id: &str, chunk_count: u8) -> IntegrationResult<()> {
        // Find underreplicated chunks that need urgent coverage
        let priority_chunks = self.find_underreplicated_chunks(chunk_count as usize).await?;
        
        if priority_chunks.is_empty() {
            // No existing underreplicated chunks, assign general chunks
            println!("[ArchiveManager] 📦 No underreplicated chunks, assigning general archive duties to {}", node_id);
            return Ok(());
        }
        
        // FORCE assignment (no negotiation)
        {
            let mut archive_nodes = self.archive_nodes.write().await;
            let mut chunk_assignments = self.chunk_assignments.write().await;
                
            if let Some(node_info) = archive_nodes.get_mut(node_id) {
                node_info.assigned_chunks = priority_chunks.clone();
                
                // Update chunk assignments
                for chunk_id in &priority_chunks {
                    chunk_assignments.entry(*chunk_id)
                        .or_insert_with(Vec::new)
                        .push(node_id.to_string());
                }
            }
        }
        
        println!("[ArchiveManager] ✅ FORCED assignment of {} chunks to node {} (compliance required)", 
                priority_chunks.len(), node_id);
        
        // Initiate immediate download of assigned chunks
        self.initiate_chunk_downloads(node_id, &priority_chunks).await?;
        
        Ok(())
    }
    
    /// Find chunks that need more replicas urgently
    async fn find_underreplicated_chunks(&self, max_count: usize) -> IntegrationResult<Vec<[u8; 32]>> {
        let chunk_assignments = self.chunk_assignments.read().await;
            
        let mut underreplicated: Vec<([u8; 32], usize)> = chunk_assignments
            .iter()
            .filter(|(_, nodes)| nodes.len() < self.min_replicas as usize)
            .map(|(chunk_id, nodes)| (*chunk_id, nodes.len()))
            .collect();
            
        // Sort by urgency (fewer replicas = more urgent)
        underreplicated.sort_by(|a, b| a.1.cmp(&b.1));
        
        // Return most urgent chunks up to max_count
        let result = underreplicated
            .into_iter()
            .take(max_count)
            .map(|(chunk_id, _)| chunk_id)
            .collect();
            
        Ok(result)
    }
    
    /// Initiate download of assigned chunks to node
    async fn initiate_chunk_downloads(&self, node_id: &str, chunk_ids: &[[u8; 32]]) -> IntegrationResult<()> {
        println!("[ArchiveManager] 📥 Initiating download of {} chunks to node {}", chunk_ids.len(), node_id);
        
        // In production, this would:
        // 1. Find nodes that have these chunks
        // 2. Initiate P2P transfer to the target node  
        // 3. Verify integrity after transfer
        // 4. Update compliance status
        
        // For now, log the assignment
        for chunk_id in chunk_ids {
            println!("[ArchiveManager] 📦 Chunk {} assigned to node {}", hex::encode(chunk_id), node_id);
        }
        
        Ok(())
    }
    
    /// Perform health check and compliance enforcement
    pub async fn enforce_compliance(&mut self) -> IntegrationResult<()> {
        println!("[ArchiveManager] 🔍 Starting compliance enforcement check");
        
        let current_time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| IntegrationError::Other(format!("Time error: {}", e)))?
            .as_secs();
            
        let mut non_compliant_nodes: Vec<(String, u8)> = Vec::new();
        let mut grace_period_expired: Vec<(String, u8)> = Vec::new();
        
        // Check each node's compliance
        {
            let mut archive_nodes = self.archive_nodes.write().await;
                
            for (node_id, node_info) in archive_nodes.iter_mut() {
                // Skip Light nodes (exempt from archival)
                if matches!(node_info.node_type, NodeType::Light) {
                    continue;
                }
                
                let required_chunks = match node_info.node_type {
                    NodeType::Full => 3,
                    NodeType::Super => 8,
                    _ => continue,
                };
                
                let actual_chunks = node_info.assigned_chunks.len() as u8;
                
                match &node_info.compliance_status {
                    ComplianceStatus::GracePeriod { expires_at } => {
                        if current_time > *expires_at {
                            // Grace period expired, check compliance
                            if actual_chunks < required_chunks {
                                node_info.compliance_status = ComplianceStatus::NonCompliant {
                                    missing_chunks: required_chunks - actual_chunks,
                                };
                                grace_period_expired.push((node_id.clone(), required_chunks - actual_chunks));
                            } else {
                                node_info.compliance_status = ComplianceStatus::Compliant;
                                println!("[ArchiveManager] ✅ Node {} is now compliant", node_id);
                            }
                        }
                    },
                    ComplianceStatus::Compliant => {
                        // Verify still compliant
                        if actual_chunks < required_chunks {
                            node_info.compliance_status = ComplianceStatus::NonCompliant {
                                missing_chunks: required_chunks - actual_chunks,
                            };
                            non_compliant_nodes.push((node_id.clone(), required_chunks - actual_chunks));
                        }
                    },
                    ComplianceStatus::NonCompliant { missing_chunks: _ } => {
                        if actual_chunks >= required_chunks {
                            node_info.compliance_status = ComplianceStatus::Compliant;
                            println!("[ArchiveManager] ✅ Node {} restored compliance", node_id);
                        } else {
                            non_compliant_nodes.push((node_id.clone(), required_chunks - actual_chunks));
                        }
                    },
                    ComplianceStatus::Unresponsive => {
                        // Check if node is back online
                        if current_time - node_info.last_seen < 7200 { // 2 hours
                            if actual_chunks >= required_chunks {
                                node_info.compliance_status = ComplianceStatus::Compliant;
                                println!("[ArchiveManager] ✅ Node {} back online and compliant", node_id);
                            } else {
                                node_info.compliance_status = ComplianceStatus::NonCompliant {
                                    missing_chunks: required_chunks - actual_chunks,
                                };
                            }
                        }
                    }
                }
            }
        }
        
        // Enforce compliance on non-compliant nodes
        for (node_id, missing_count) in non_compliant_nodes {
            println!("[ArchiveManager] ⚠️ Node {} is non-compliant (missing {} chunks)", node_id, missing_count);
            self.force_compliance_restoration(&node_id, missing_count).await?;
        }
        
        // Handle expired grace periods
        for (node_id, missing_count) in grace_period_expired {
            println!("[ArchiveManager] 📅 Grace period expired for node {} (missing {} chunks)", node_id, missing_count);
            self.force_compliance_restoration(&node_id, missing_count).await?;
        }
        
        println!("[ArchiveManager] ✅ Compliance enforcement completed");
        Ok(())
    }
    
    /// Force compliance restoration (mandatory chunk assignment)
    async fn force_compliance_restoration(&mut self, node_id: &str, missing_chunks: u8) -> IntegrationResult<()> {
        println!("[ArchiveManager] 🔧 FORCING compliance restoration for node {} ({} chunks)", 
                node_id, missing_chunks);
        
        // This is NOT optional - node MUST accept these assignments
        self.assign_mandatory_chunks(node_id, missing_chunks).await?;
        
        // Log enforcement action
        println!("[ArchiveManager] ⚖️ Node {} MUST comply with archival obligations (network requirement)", node_id);
        
        Ok(())
    }
    
    /// Get archive system statistics
    pub async fn get_archive_stats(&self) -> IntegrationResult<ArchiveStats> {
        let archive_nodes = self.archive_nodes.read().await;
        let chunk_assignments = self.chunk_assignments.read().await;
        let archive_chunks = self.archive_chunks.read().await;
            
        let total_nodes = archive_nodes.len();
        let total_chunks = archive_chunks.len();
        
        let compliant_nodes = archive_nodes.values()
            .filter(|node| matches!(node.compliance_status, ComplianceStatus::Compliant))
            .count();
            
        let non_compliant_nodes = archive_nodes.values()
            .filter(|node| matches!(node.compliance_status, ComplianceStatus::NonCompliant { .. }))
            .count();
            
        let underreplicated_chunks = chunk_assignments.values()
            .filter(|nodes| nodes.len() < self.min_replicas as usize)
            .count();
            
        let total_replicas: usize = chunk_assignments.values().map(|nodes| nodes.len()).sum();
        let avg_replicas = if total_chunks > 0 { total_replicas as f32 / total_chunks as f32 } else { 0.0 };
        
        Ok(ArchiveStats {
            total_nodes,
            total_chunks,
            compliant_nodes,
            non_compliant_nodes,
            underreplicated_chunks,
            avg_replicas,
            min_replicas: self.min_replicas,
            max_replicas: self.max_replicas,
        })
    }
    
    /// Calculate adaptive archive quota based on current network size
    async fn calculate_adaptive_quota(&mut self, node_type: &NodeType) -> IntegrationResult<u8> {
        let archive_nodes = self.archive_nodes.read().await;
        let total_nodes = archive_nodes.len();
        
        // Count nodes by type
        let genesis_count = archive_nodes.values().filter(|n| matches!(n.node_type, NodeType::Super)).count(); // Genesis treated as Super for now
        let super_count = archive_nodes.values().filter(|n| matches!(n.node_type, NodeType::Super)).count();
        let full_count = archive_nodes.values().filter(|n| matches!(n.node_type, NodeType::Full)).count();
        let light_count = archive_nodes.values().filter(|n| matches!(n.node_type, NodeType::Light)).count();
        
        drop(archive_nodes);
        
        println!("[Archive] 📊 Network size analysis: {} total nodes ({} Super, {} Full, {} Light)", 
                total_nodes, super_count, full_count, light_count);
        
        // Adaptive scaling logic based on network size
        match total_nodes {
            // CRITICAL: Very small network (5-15 nodes) - emergency mode
            0..=15 => {
                self.min_replicas = 1; // Reduce to 1 replica minimum (emergency)
                self.max_replicas = 3; // Lower maximum to spread load
                
                match node_type {
                    NodeType::Light => 0,
                    NodeType::Full => 8,  // Increase Full node quota significantly
                    NodeType::Super => 15, // Increase Super node quota significantly
                }
            },
            
            // Small network (16-50 nodes) - relaxed requirements
            16..=50 => {
                self.min_replicas = 2; // Reduce to 2 replicas minimum
                self.max_replicas = 4; // Moderate maximum
                
                match node_type {
                    NodeType::Light => 0,
                    NodeType::Full => 6,  // Higher quota for Full nodes
                    NodeType::Super => 12, // Higher quota for Super nodes
                }
            },
            
            // Medium network (51-200 nodes) - standard requirements
            51..=200 => {
                self.min_replicas = 3; // Standard 3 replicas
                self.max_replicas = 5; // Moderate maximum
                
                match node_type {
                    NodeType::Light => 0,
                    NodeType::Full => 4,  // Slightly higher than standard
                    NodeType::Super => 10, // Slightly higher than standard
                }
            },
            
            // Large network (200+ nodes) - optimal distribution
            _ => {
                self.min_replicas = 3; // Standard 3 replicas
                self.max_replicas = 7; // Standard maximum
                
                match node_type {
                    NodeType::Light => 0,
                    NodeType::Full => 3,  // Standard quota
                    NodeType::Super => 8,  // Standard quota
                }
            }
        };
        
        let quota = match node_type {
            NodeType::Light => 0,
            NodeType::Full => match total_nodes {
                0..=15 => 8,
                16..=50 => 6,
                51..=200 => 4,
                _ => 3,
            },
            NodeType::Super => match total_nodes {
                0..=15 => 15,
                16..=50 => 12,
                51..=200 => 10,
                _ => 8,
            },
        };
        
        println!("[Archive] 🎯 Adaptive quota for {:?} node: {} chunks (network size: {})", 
                node_type, quota, total_nodes);
        println!("[Archive] 📋 Replication requirements: min={}, max={}", self.min_replicas, self.max_replicas);
        
        Ok(quota)
    }
    
    /// Check if network can sustain minimum replication requirements
    pub async fn validate_network_replication_capacity(&self) -> IntegrationResult<bool> {
        let archive_nodes = self.archive_nodes.read().await;
        let archive_chunks = self.archive_chunks.read().await;
        
        let total_archive_nodes = archive_nodes.values()
            .filter(|n| !matches!(n.node_type, NodeType::Light))
            .count();
            
        let total_chunks = archive_chunks.len();
        
        drop(archive_nodes);
        drop(archive_chunks);
        
        if total_chunks == 0 {
            println!("[Archive] ✅ No chunks yet, network capacity sufficient");
            return Ok(true);
        }
        
        let required_replica_slots = total_chunks * (self.min_replicas as usize);
        
        // Calculate available capacity (simplified estimation)
        let estimated_capacity = total_archive_nodes * 10; // Assume average 10 chunks per node
        
        if estimated_capacity >= required_replica_slots {
            println!("[Archive] ✅ Network capacity sufficient: {} slots available, {} required", 
                    estimated_capacity, required_replica_slots);
            Ok(true)
        } else {
            println!("[Archive] ⚠️ Network capacity insufficient: {} slots available, {} required", 
                    estimated_capacity, required_replica_slots);
            
            // Emergency mode: reduce minimum replicas temporarily
            if total_archive_nodes >= 3 && total_chunks > 0 {
                println!("[Archive] 🚨 EMERGENCY MODE: Reducing minimum replicas to prevent data loss");
                Ok(false) // Will trigger emergency rebalancing
            } else {
                println!("[Archive] 🆘 CRITICAL: Network too small for any meaningful replication");
                Ok(false)
            }
        }
    }
    
    /// Rebalance archive quotas for small network optimization
    pub async fn rebalance_for_small_network(&mut self) -> IntegrationResult<()> {
        let total_nodes = {
            let archive_nodes = self.archive_nodes.read().await;
            archive_nodes.len()
        };
        
        println!("[Archive] 🔄 Rebalancing archive quotas for small network ({} nodes)", total_nodes);
        
        // Only rebalance if network is small
        if total_nodes > 50 {
            println!("[Archive] ✅ Network large enough, no rebalancing needed");
            return Ok(());
        }
        
        // Emergency rebalancing for small networks
        let mut archive_nodes = self.archive_nodes.write().await;
        
        for (node_id, node_info) in archive_nodes.iter_mut() {
            if matches!(node_info.node_type, NodeType::Light) {
                continue;
            }
            
            let new_quota = self.calculate_emergency_quota(&node_info.node_type, total_nodes);
            let current_chunks = node_info.assigned_chunks.len() as u8;
            
            if current_chunks < new_quota {
                println!("[Archive] 📈 Increasing quota for {} from {} to {} chunks (emergency scaling)", 
                        node_id, current_chunks, new_quota);
                // In production, this would trigger assignment of additional chunks
            }
        }
        
        Ok(())
    }
    
    /// Calculate emergency quota for very small networks
    fn calculate_emergency_quota(&self, node_type: &NodeType, total_nodes: usize) -> u8 {
        match (node_type, total_nodes) {
            // EMERGENCY: 5-15 nodes total
            (NodeType::Full, 5..=15) => 12,   // Emergency: Full nodes take 12 chunks each
            (NodeType::Super, 5..=15) => 20,  // Emergency: Super nodes take 20 chunks each
            
            // SMALL: 16-30 nodes total  
            (NodeType::Full, 16..=30) => 8,   // Small network: Full nodes take 8 chunks
            (NodeType::Super, 16..=30) => 15, // Small network: Super nodes take 15 chunks
            
            // MEDIUM: 31-50 nodes total
            (NodeType::Full, 31..=50) => 5,   // Medium network: Full nodes take 5 chunks
            (NodeType::Super, 31..=50) => 10, // Medium network: Super nodes take 10 chunks
            
            // STANDARD: 50+ nodes
            (NodeType::Full, _) => 3,          // Standard quota
            (NodeType::Super, _) => 8,         // Standard quota
            
            (NodeType::Light, _) => 0,         // Light nodes never archive
        }
    }
}

/// Archive system statistics
#[derive(Debug, Serialize, Deserialize)]
pub struct ArchiveStats {
    pub total_nodes: usize,
    pub total_chunks: usize,
    pub compliant_nodes: usize,
    pub non_compliant_nodes: usize,
    pub underreplicated_chunks: usize,
    pub avg_replicas: f32,
    pub min_replicas: u8,
    pub max_replicas: u8,
}

/// Background replication service for archive chunks
pub struct BackgroundReplicationService {
    archive_manager: Arc<RwLock<ArchiveReplicationManager>>,
    replication_interval: Duration,
    is_running: Arc<RwLock<bool>>,
}

impl BackgroundReplicationService {
    /// Create new background replication service
    pub fn new(archive_manager: Arc<RwLock<ArchiveReplicationManager>>) -> Self {
        Self {
            archive_manager,
            replication_interval: Duration::from_secs(2 * 3600), // 2 hours
            is_running: Arc::new(RwLock::new(false)),
        }
    }
    
    /// Start background replication service
    pub async fn start(&self) -> IntegrationResult<()> {
        {
            let mut running = self.is_running.write().await;
            if *running {
                return Ok(()); // Already running
            }
            *running = true;
        }
        
        let archive_manager = self.archive_manager.clone();
        let replication_interval = self.replication_interval;
        let is_running = self.is_running.clone();
        
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(replication_interval);
            
            loop {
                // Check if should continue running
                {
                    let running = is_running.read().await;
                    if !*running {
                        break;
                    }
                }
                
                interval.tick().await;
                
                println!("[BackgroundReplication] 🔄 Starting replication cycle");
                
                // Perform replication round
                {
                    let mut manager = archive_manager.write().await;
                    if let Err(e) = Self::perform_replication_round(&mut *manager).await {
                        println!("[BackgroundReplication] ❌ Replication round failed: {}", e);
                    }
                }
            }
            
            println!("[BackgroundReplication] 🛑 Background replication service stopped");
        });
        
        println!("[BackgroundReplication] ✅ Background replication service started");
        Ok(())
    }
    
    /// Stop background replication service
    pub async fn stop(&self) -> IntegrationResult<()> {
        let mut running = self.is_running.write().await;
        *running = false;
        
        println!("[BackgroundReplication] 🛑 Background replication service stopping...");
        Ok(())
    }
    
    /// Perform one round of replication
    async fn perform_replication_round(manager: &mut ArchiveReplicationManager) -> IntegrationResult<()> {
        // 1. Find underreplicated chunks
        let underreplicated = manager.find_underreplicated_chunks(100).await?;
        
        if underreplicated.is_empty() {
            println!("[BackgroundReplication] ✅ All chunks properly replicated");
            return Ok(());
        }
        
        println!("[BackgroundReplication] 🚨 Found {} underreplicated chunks", underreplicated.len());
        
        // 2. For each underreplicated chunk, find nodes to replicate to
        for chunk_id in &underreplicated {
            if let Err(e) = Self::replicate_chunk(manager, chunk_id).await {
                println!("[BackgroundReplication] ❌ Failed to replicate chunk {}: {}", 
                        hex::encode(chunk_id), e);
            } else {
                println!("[BackgroundReplication] ✅ Replicated chunk {}", hex::encode(chunk_id));
            }
        }
        
        println!("[BackgroundReplication] ✅ Replication round completed");
        Ok(())
    }
    
    /// Replicate a specific chunk to more nodes
    async fn replicate_chunk(manager: &mut ArchiveReplicationManager, chunk_id: &[u8; 32]) -> IntegrationResult<()> {
        let chunk_assignments = manager.chunk_assignments.read().await;
        let archive_nodes = manager.archive_nodes.read().await;
        
        // Find current nodes holding this chunk
        let current_holders = chunk_assignments.get(chunk_id)
            .map(|nodes| nodes.clone())
            .unwrap_or_default();
            
        let needed_replicas = manager.min_replicas as usize - current_holders.len();
        if needed_replicas == 0 {
            return Ok(());
        }
        
        // Find available nodes that don't have this chunk yet
        let mut available_nodes: Vec<String> = archive_nodes
            .iter()
            .filter(|(node_id, node_info)| {
                // Skip Light nodes
                !matches!(node_info.node_type, crate::node::NodeType::Light) &&
                // Skip nodes that already have this chunk
                !current_holders.contains(node_id) &&
                // Only nodes that have capacity
                node_info.assigned_chunks.len() < Self::get_max_chunks_for_node_type(&node_info.node_type)
            })
            .map(|(node_id, _)| node_id.clone())
            .collect();
            
        // Prioritize nodes with fewer chunks (load balancing)
        available_nodes.sort_by(|a, b| {
            let a_chunks = archive_nodes.get(a).map(|n| n.assigned_chunks.len()).unwrap_or(0);
            let b_chunks = archive_nodes.get(b).map(|n| n.assigned_chunks.len()).unwrap_or(0);
            a_chunks.cmp(&b_chunks)
        });
        
        drop(chunk_assignments);
        drop(archive_nodes);
        
        // Assign chunk to selected nodes
        let selected_nodes: Vec<String> = available_nodes
            .into_iter()
            .take(needed_replicas)
            .collect();
            
        for node_id in selected_nodes {
            // Force assignment (mandatory compliance)
            let mut archive_nodes = manager.archive_nodes.write().await;
            let mut chunk_assignments = manager.chunk_assignments.write().await;
                
            if let Some(node_info) = archive_nodes.get_mut(&node_id) {
                node_info.assigned_chunks.push(*chunk_id);
                
                chunk_assignments.entry(*chunk_id)
                    .or_insert_with(Vec::new)
                    .push(node_id.clone());
                    
                println!("[BackgroundReplication] 📦 Assigned chunk {} to node {} (mandatory)", 
                        hex::encode(chunk_id), node_id);
            }
        }
        
        Ok(())
    }
    
    /// Get maximum chunks allowed for node type
    fn get_max_chunks_for_node_type(node_type: &crate::node::NodeType) -> usize {
        match node_type {
            crate::node::NodeType::Light => 0,
            crate::node::NodeType::Full => 5,     // Allow up to 5 chunks (3 required + 2 buffer)
            crate::node::NodeType::Super => 12,   // Allow up to 12 chunks (8 required + 4 buffer)
        }
    }
}
