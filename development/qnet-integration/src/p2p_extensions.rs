//! P2P Extensions for Progressive Finalization Protocol

impl super::unified_p2p::SimplifiedP2P {
    /// Get node ID for Progressive Finalization Protocol
    pub fn get_node_id(&self) -> String {
        self.node_id.clone()
    }
    
    /// Broadcast emergency finalization to network (Progressive Finalization Protocol)
    pub fn broadcast_emergency_finalization(
        &self,
        height: u64,
        participants: Vec<String>,
    ) -> Result<(), String> {
        println!("[P2P] 📍 Broadcasting emergency finalization at height {} with {} participants", 
                 height, participants.len());
        
        // Create emergency finalization data
        #[derive(serde::Serialize)]
        struct EmergencyFinalization {
            height: u64,
            participants: Vec<String>,
            finalization_type: String,
            timestamp: u64,
        }
        
        let emergency_data = EmergencyFinalization {
            height,
            participants,
            finalization_type: "emergency".to_string(),
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        };
        
        let serialized = bincode::serialize(&emergency_data)
            .map_err(|e| format!("Failed to serialize emergency finalization: {}", e))?;
        
        // Broadcast as special block type
        self.broadcast_block(height, serialized)?;
        
        Ok(())
    }
    
    /// Broadcast critical alert when network is in degraded state
    pub fn broadcast_critical_alert(&self, height: u64) -> Result<(), String> {
        println!("🚨 CRITICAL ALERT: Network forcing single-node finalization at height {}", height);
        
        // Create critical alert data
        #[derive(serde::Serialize)]
        struct CriticalAlert {
            height: u64,
            alert_type: String,
            message: String,
            timestamp: u64,
        }
        
        let alert = CriticalAlert {
            height,
            alert_type: "CRITICAL_NETWORK_STATE".to_string(),
            message: format!("CRITICAL: Single-node finalization at height {}", height),
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        };
        
        let serialized = bincode::serialize(&alert)
            .map_err(|e| format!("Failed to serialize critical alert: {}", e))?;
        
        // Broadcast as special block type
        self.broadcast_block(height, serialized)?;
        
        // Log critical state
        println!("[P2P] ⚠️ CRITICAL STATE: Network degraded to single-node consensus");
        println!("[P2P] ⚠️ CRITICAL STATE: Manual intervention may be required");
        
        Ok(())
    }
}
