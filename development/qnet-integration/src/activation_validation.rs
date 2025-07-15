use std::collections::{HashMap, HashSet};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;
use serde::{Deserialize, Serialize};
use sha3::{Sha3_256, Digest};
use crate::errors::IntegrationError;

/// Efficient activation code validation with caching and DHT
#[derive(Debug)]
pub struct ActivationValidator {
    /// Cache of used activation codes
    used_codes: RwLock<HashSet<String>>,
    /// Cache of active nodes by device signature
    active_nodes: RwLock<HashMap<String, NodeInfo>>,
    /// Last blockchain sync timestamp
    last_sync: RwLock<u64>,
    /// Cache TTL in seconds (1 hour)
    cache_ttl: u64,
    /// DHT peer network for distributed validation
    dht_client: Option<DhtClient>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeInfo {
    pub activation_code: String,
    pub wallet_address: String,
    pub device_signature: String,
    pub node_type: String,
    pub activated_at: u64,
    pub last_seen: u64,
}

#[derive(Debug)]
pub struct DhtClient {
    // DHT implementation placeholder
    peer_count: usize,
}

impl ActivationValidator {
    pub fn new() -> Self {
        Self {
            used_codes: RwLock::new(HashSet::new()),
            active_nodes: RwLock::new(HashMap::new()),
            last_sync: RwLock::new(0),
            cache_ttl: 3600, // 1 hour
            dht_client: Some(DhtClient { peer_count: 0 }),
        }
    }

    /// Check if activation code is already used (efficient, cached)
    pub async fn is_code_used(&self, code: &str) -> Result<bool, IntegrationError> {
        // Check cache first (fast)
        {
            let used_codes = self.used_codes.read().await;
            if used_codes.contains(code) {
                return Ok(true);
            }
        }

        // Check if we need to sync with network
        if self.needs_sync().await {
            self.sync_from_network().await?;
        }

        // Check cache again after sync
        let used_codes = self.used_codes.read().await;
        Ok(used_codes.contains(code))
    }

    /// Register new activation code
    pub async fn register_activation(&self, code: &str, node_info: NodeInfo) -> Result<(), IntegrationError> {
        // Check if code is already used
        if self.is_code_used(code).await? {
            return Err(IntegrationError::ValidationError(
                "Activation code already in use".to_string()
            ));
        }

        // Check device limit for light nodes
        if node_info.node_type == "light" {
            let device_count = self.get_wallet_device_count(&node_info.wallet_address).await?;
            if device_count >= 3 {
                return Err(IntegrationError::ValidationError(
                    "Maximum 3 devices allowed for Light nodes".to_string()
                ));
            }
        }

        // Check if device already has an active node
        if self.device_has_active_node(&node_info.device_signature).await? {
            return Err(IntegrationError::ValidationError(
                "Device already has an active node".to_string()
            ));
        }

        // Register in local cache
        {
            let mut used_codes = self.used_codes.write().await;
            used_codes.insert(code.to_string());
        }

        {
            let mut active_nodes = self.active_nodes.write().await;
            active_nodes.insert(node_info.device_signature.clone(), node_info.clone());
        }

        // Propagate to DHT (distributed, async)
        if let Some(dht) = &self.dht_client {
            tokio::spawn(async move {
                // DHT propagation in background
                let _ = Self::propagate_to_dht(code, &node_info).await;
            });
        }

        Ok(())
    }

    /// Migrate device (same wallet, different device)
    pub async fn migrate_device(&self, code: &str, wallet_address: &str, new_device_signature: &str) -> Result<(), IntegrationError> {
        // Validate ownership
        if !self.verify_wallet_ownership(wallet_address, code).await? {
            return Err(IntegrationError::ValidationError(
                "Wallet does not own this activation code".to_string()
            ));
        }

        // Check if new device already has a node
        if self.device_has_active_node(new_device_signature).await? {
            return Err(IntegrationError::ValidationError(
                "New device already has an active node".to_string()
            ));
        }

        // Update device signature in cache
        {
            let mut active_nodes = self.active_nodes.write().await;
            
            // Find and update the node
            let mut node_to_update = None;
            for (device_sig, node_info) in active_nodes.iter() {
                if node_info.activation_code == code && node_info.wallet_address == wallet_address {
                    node_to_update = Some((device_sig.clone(), node_info.clone()));
                    break;
                }
            }

            if let Some((old_device_sig, mut node_info)) = node_to_update {
                // Remove old device entry
                active_nodes.remove(&old_device_sig);
                
                // Update device signature
                node_info.device_signature = new_device_signature.to_string();
                
                // Add new device entry
                active_nodes.insert(new_device_signature.to_string(), node_info);
            }
        }

        Ok(())
    }

    /// Check if device has an active node
    async fn device_has_active_node(&self, device_signature: &str) -> Result<bool, IntegrationError> {
        let active_nodes = self.active_nodes.read().await;
        Ok(active_nodes.contains_key(device_signature))
    }

    /// Get device count for wallet (Light nodes only)
    async fn get_wallet_device_count(&self, wallet_address: &str) -> Result<usize, IntegrationError> {
        let active_nodes = self.active_nodes.read().await;
        
        let count = active_nodes.values()
            .filter(|node| node.wallet_address == wallet_address && node.node_type == "light")
            .count();
        
        Ok(count)
    }

    /// Verify wallet ownership of activation code
    async fn verify_wallet_ownership(&self, wallet_address: &str, activation_code: &str) -> Result<bool, IntegrationError> {
        let active_nodes = self.active_nodes.read().await;
        
        let owned = active_nodes.values()
            .any(|node| node.wallet_address == wallet_address && node.activation_code == activation_code);
        
        Ok(owned)
    }

    /// Check if cache needs sync with network
    async fn needs_sync(&self) -> bool {
        let last_sync = *self.last_sync.read().await;
        let current_time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        
        current_time - last_sync > self.cache_ttl
    }

    /// Sync cache from network (efficient, periodic)
    async fn sync_from_network(&self) -> Result<(), IntegrationError> {
        println!("🔄 Syncing activation cache from network...");
        
        // Update last sync timestamp
        {
            let mut last_sync = self.last_sync.write().await;
            *last_sync = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs();
        }

        // Sync from DHT peers (distributed)
        if let Some(_dht) = &self.dht_client {
            // Get recent activations from DHT
            let recent_activations = self.fetch_recent_activations().await?;
            
            // Update cache
            {
                let mut used_codes = self.used_codes.write().await;
                for activation in &recent_activations {
                    used_codes.insert(activation.activation_code.clone());
                }
            }
            
            {
                let mut active_nodes = self.active_nodes.write().await;
                for activation in recent_activations {
                    active_nodes.insert(activation.device_signature.clone(), activation);
                }
            }
        }

        // Cleanup expired entries
        self.cleanup_expired_entries().await;
        
        println!("✅ Cache sync completed");
        Ok(())
    }

    /// Fetch recent activations from DHT
    async fn fetch_recent_activations(&self) -> Result<Vec<NodeInfo>, IntegrationError> {
        // Mock implementation - in production this would query DHT peers
        tokio::time::sleep(Duration::from_millis(100)).await;
        Ok(vec![])
    }

    /// Cleanup expired entries from cache
    async fn cleanup_expired_entries(&self) {
        let current_time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        
        let mut active_nodes = self.active_nodes.write().await;
        
        // Remove nodes that haven't been seen for more than 24 hours
        active_nodes.retain(|_, node| {
            current_time - node.last_seen < 24 * 3600
        });
    }

    /// Propagate activation to DHT network
    async fn propagate_to_dht(code: &str, node_info: &NodeInfo) -> Result<(), IntegrationError> {
        // Mock implementation - in production this would propagate to DHT
        println!("📡 Propagating activation {} to DHT network", code);
        tokio::time::sleep(Duration::from_millis(50)).await;
        Ok(())
    }

    /// Start background sync task
    pub async fn start_background_sync(&self) {
        let validator = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(3600)); // 1 hour
            
            loop {
                interval.tick().await;
                
                if let Err(e) = validator.sync_from_network().await {
                    eprintln!("❌ Background sync failed: {}", e);
                }
            }
        });
    }
}

// Make ActivationValidator cloneable for background tasks
impl Clone for ActivationValidator {
    fn clone(&self) -> Self {
        Self {
            used_codes: RwLock::new(HashSet::new()),
            active_nodes: RwLock::new(HashMap::new()),
            last_sync: RwLock::new(0),
            cache_ttl: self.cache_ttl,
            dht_client: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_activation_validation() {
        let validator = ActivationValidator::new();
        
        let node_info = NodeInfo {
            activation_code: "QNET-TEST-CODE-001".to_string(),
            wallet_address: "wallet123".to_string(),
            device_signature: "device456".to_string(),
            node_type: "light".to_string(),
            activated_at: 1234567890,
            last_seen: 1234567890,
        };

        // First activation should succeed
        assert!(validator.register_activation("QNET-TEST-CODE-001", node_info.clone()).await.is_ok());
        
        // Second activation with same code should fail
        assert!(validator.register_activation("QNET-TEST-CODE-001", node_info).await.is_err());
    }

    #[tokio::test]
    async fn test_device_migration() {
        let validator = ActivationValidator::new();
        
        let node_info = NodeInfo {
            activation_code: "QNET-TEST-CODE-002".to_string(),
            wallet_address: "wallet123".to_string(),
            device_signature: "device456".to_string(),
            node_type: "full".to_string(),
            activated_at: 1234567890,
            last_seen: 1234567890,
        };

        // Register initial activation
        validator.register_activation("QNET-TEST-CODE-002", node_info).await.unwrap();
        
        // Migrate to new device
        assert!(validator.migrate_device("QNET-TEST-CODE-002", "wallet123", "device789").await.is_ok());
        
        // Check new device is active
        assert!(validator.device_has_active_node("device789").await.unwrap());
        
        // Check old device is no longer active
        assert!(!validator.device_has_active_node("device456").await.unwrap());
    }
} 