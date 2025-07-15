//! Persistent storage implementation for QNet blockchain

use rocksdb::{DB, Options, ColumnFamily, ColumnFamilyDescriptor, WriteBatch};
use qnet_state::{Block, Account};
use crate::errors::{IntegrationError, IntegrationResult};
use std::path::Path;
use std::collections::HashMap;
use hex;
use sha3;
use bincode;

pub struct PersistentStorage {
    db: DB,
}

#[derive(Debug, Clone, Default)]
pub struct StorageStats {
    pub total_blocks: u64,
    pub total_transactions: u64,
    pub total_accounts: u64,
    pub latest_height: u64,
}

impl PersistentStorage {
    pub fn new(data_dir: &str) -> IntegrationResult<Self> {
        let path = Path::new(data_dir);
        std::fs::create_dir_all(path)?;
        
        // Simple, reliable RocksDB configuration
        let mut opts = Options::default();
        opts.create_if_missing(true);
        opts.create_missing_column_families(true);
        
        // Basic settings that work reliably
        opts.set_max_open_files(1000);
        opts.set_use_fsync(false);
        opts.set_bytes_per_sync(1048576);
        opts.set_max_write_buffer_number(4);
        opts.set_write_buffer_size(67108864); // 64MB
        opts.set_target_file_size_base(67108864); // 64MB
        opts.set_min_write_buffer_number_to_merge(2);
        opts.set_level_zero_stop_writes_trigger(12);
        opts.set_level_zero_slowdown_writes_trigger(8);
        opts.set_compaction_style(rocksdb::DBCompactionStyle::Level);
        opts.set_max_background_jobs(4);
        opts.set_disable_auto_compactions(false);
        
        let cfs = vec![
            ColumnFamilyDescriptor::new("blocks", Options::default()),
            ColumnFamilyDescriptor::new("transactions", Options::default()),
            ColumnFamilyDescriptor::new("accounts", Options::default()),
            ColumnFamilyDescriptor::new("metadata", Options::default()),
            ColumnFamilyDescriptor::new("microblocks", Options::default()),
        ];
        
        let db = match DB::open_cf_descriptors(&opts, path, cfs) {
            Ok(db) => db,
            Err(e) => {
                eprintln!("❌ RocksDB Error: {}", e);
                return Err(IntegrationError::StorageError(format!("RocksDB initialization failed: {}", e)));
            }
        };
        
        Ok(Self { db })
    }
    
    pub async fn save_block(&self, block: &qnet_state::Block) -> IntegrationResult<()> {
        let block_cf = self.db.cf_handle("blocks")
            .ok_or_else(|| IntegrationError::StorageError("blocks column family not found".to_string()))?;
        let tx_cf = self.db.cf_handle("transactions")
            .ok_or_else(|| IntegrationError::StorageError("transactions column family not found".to_string()))?;
        
        let block_key = format!("block_{}", block.height);
        let block_data = bincode::serialize(block)
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        
        let mut batch = WriteBatch::default();
        batch.put_cf(&block_cf, block_key.as_bytes(), &block_data);
        
        // Store block hash mapping
        let hash_key = format!("hash_{}", block.height);
        let hash_data = bincode::serialize(&block.hash())
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        batch.put_cf(&block_cf, hash_key.as_bytes(), &hash_data);
        
        // Store transactions
        for tx in &block.transactions {
            let tx_key = format!("tx_{}", tx.hash);
            let tx_data = bincode::serialize(tx)
                .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
            
            batch.put_cf(&tx_cf, tx_key.as_bytes(), &tx_data);
        }
        
        // Update chain height
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        batch.put_cf(&metadata_cf, b"chain_height", &block.height.to_be_bytes());
        
        self.db.write(batch)?;
        Ok(())
    }
    
    pub fn get_chain_height(&self) -> IntegrationResult<u64> {
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        
        match self.db.get_cf(&metadata_cf, b"chain_height")? {
            Some(data) => {
                if data.len() >= 8 {
                    let height_bytes: [u8; 8] = data[0..8].try_into()
                        .map_err(|_| IntegrationError::StorageError("Invalid height data".to_string()))?;
                    Ok(u64::from_be_bytes(height_bytes))
                } else {
                    Ok(0)
                }
            }
            None => Ok(0),
        }
    }
    
    pub fn get_block_hash(&self, height: u64) -> IntegrationResult<Option<String>> {
        let block_cf = self.db.cf_handle("blocks")
            .ok_or_else(|| IntegrationError::StorageError("blocks column family not found".to_string()))?;
        
        let hash_key = format!("hash_{}", height);
        match self.db.get_cf(&block_cf, hash_key.as_bytes())? {
            Some(data) => {
                let hash: [u8; 32] = bincode::deserialize(&data)
                    .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
                Ok(Some(hex::encode(hash)))
            }
            None => Ok(None),
        }
    }
    
    pub async fn load_block_by_height(&self, height: u64) -> IntegrationResult<Option<qnet_state::Block>> {
        let block_cf = self.db.cf_handle("blocks")
            .ok_or_else(|| IntegrationError::StorageError("blocks column family not found".to_string()))?;
        
        let block_key = format!("block_{}", height);
        match self.db.get_cf(&block_cf, block_key.as_bytes())? {
            Some(data) => {
                let block: qnet_state::Block = bincode::deserialize(&data)
                    .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
                Ok(Some(block))
            }
            None => Ok(None),
        }
    }
    
    pub async fn save_account(&self, account: &qnet_state::Account) -> IntegrationResult<()> {
        let accounts_cf = self.db.cf_handle("accounts")
            .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;
        
        let account_data = bincode::serialize(account)
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        
        self.db.put_cf(&accounts_cf, account.address.as_bytes(), &account_data)?;
        Ok(())
    }
    
    pub fn save_microblock(&self, height: u64, data: &[u8]) -> IntegrationResult<()> {
        let microblocks_cf = self.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        
        let key = format!("microblock_{}", height);
        self.db.put_cf(&microblocks_cf, key.as_bytes(), data)?;
        Ok(())
    }
    
    /// Save activation code to persistent storage with code-based binding
    pub fn save_activation_code(&self, code: &str, node_type: u8, timestamp: u64) -> IntegrationResult<()> {
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        
        // Generate cryptographic node identity from activation code
        let node_identity = Self::generate_node_identity(code, node_type, timestamp)?;
        let server_ip = Self::get_server_ip();
        
        // Create secure state binding
        let state_key = Self::derive_state_key(code, &node_identity)?;
        
        // Save with cryptographic binding to activation code
        let activation_data = format!("{}:{}:{}:{}:{}", 
            code, node_type, timestamp, node_identity, server_ip);
        
        // Encrypt entire record with code-derived key
        let encrypted_data = Self::encrypt_with_code_key(&activation_data, &state_key)?;
        
        self.db.put_cf(&metadata_cf, b"activation_code", encrypted_data.as_bytes())?;
        
        // Save state key for validation
        self.db.put_cf(&metadata_cf, b"state_key", state_key.as_bytes())?;
        
        Ok(())
    }
    
    /// Load activation code from persistent storage with code-based validation
    pub fn load_activation_code(&self) -> IntegrationResult<Option<(String, u8, u64)>> {
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        
        match self.db.get_cf(&metadata_cf, b"activation_code")? {
            Some(encrypted_data) => {
                // Load state key for decryption
                let state_key = match self.db.get_cf(&metadata_cf, b"state_key")? {
                    Some(key) => String::from_utf8_lossy(&key).to_string(),
                    None => {
                        // Try legacy format
                        return self.load_legacy_activation_code(&encrypted_data);
                    }
                };
                
                // Decrypt with code-derived key
                let decrypted_data = Self::decrypt_with_code_key(&String::from_utf8_lossy(&encrypted_data), &state_key)?;
                
                let parts: Vec<&str> = decrypted_data.split(':').collect();
                
                // New secure format: code:node_type:timestamp:node_identity:server_ip[:migration:new_device_signature]
                if parts.len() == 5 || parts.len() == 7 {
                    let code = parts[0];
                    let node_type = parts[1].parse::<u8>().unwrap_or(1);
                    let timestamp = parts[2].parse::<u64>().unwrap_or(0);
                    let stored_node_identity = parts[3];
                    let stored_server_ip = parts[4];
                    
                    // Check if this is a migrated device
                    let is_migrated = parts.len() == 7 && parts[5] == "migration";
                    let device_signature = if is_migrated { Some(parts[6]) } else { None };
                    
                    // Validate node identity (considering migration)
                    let current_node_identity = if is_migrated {
                        Self::generate_migration_identity(code, node_type, timestamp, device_signature.unwrap())?
                    } else {
                        Self::generate_node_identity(code, node_type, timestamp)?
                    };
                    
                    if current_node_identity != stored_node_identity {
                        eprintln!("🚨 SECURITY WARNING: Node identity mismatch!");
                        eprintln!("   This activation code was bound to a different node configuration");
                        return Err(IntegrationError::SecurityError("Node identity mismatch".to_string()));
                    }
                    
                    // Validate state key consistency
                    let expected_state_key = Self::derive_state_key(code, &current_node_identity)?;
                    if expected_state_key != state_key {
                        eprintln!("🚨 SECURITY WARNING: State key mismatch!");
                        eprintln!("   Activation code integrity compromised");
                        return Err(IntegrationError::SecurityError("State key mismatch".to_string()));
                    }
                    
                    // Log IP changes (device migration is normal)
                    let current_server_ip = Self::get_server_ip();
                    if current_server_ip != stored_server_ip {
                        println!("📍 INFO: Server IP changed from {} to {} (device migration/restart)", stored_server_ip, current_server_ip);
                    }
                    
                    // Log migration status
                    if is_migrated {
                        println!("🔄 INFO: Device was migrated to signature: {}", device_signature.unwrap());
                    }
                    
                    println!("✅ Activation code validated with cryptographic binding");
                    Ok(Some((code.to_string(), node_type, timestamp)))
                } else {
                    Err(IntegrationError::SecurityError("Invalid activation record format".to_string()))
                }
            }
            None => Ok(None),
        }
    }
    
    /// Load legacy activation code format for backwards compatibility
    fn load_legacy_activation_code(&self, data: &[u8]) -> IntegrationResult<Option<(String, u8, u64)>> {
        let activation_str = String::from_utf8_lossy(data);
        let parts: Vec<&str> = activation_str.split(':').collect();
        
        if parts.len() == 3 {
            println!("⚠️  WARNING: Using legacy activation format (upgrading to secure format recommended)");
            let code = parts[0].to_string();
            let node_type = parts[1].parse::<u8>().unwrap_or(1);
            let timestamp = parts[2].parse::<u64>().unwrap_or(0);
            Ok(Some((code, node_type, timestamp)))
        } else {
            Ok(None)
        }
    }
    
    /// Clear activation code (for security)
    pub fn clear_activation_code(&self) -> IntegrationResult<()> {
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        
        self.db.delete_cf(&metadata_cf, b"activation_code")?;
        self.db.delete_cf(&metadata_cf, b"state_key")?;
        Ok(())
    }
    
    /// Update activation code for device migration (preserves activation, updates device)
    pub fn update_activation_for_migration(&self, code: &str, node_type: u8, timestamp: u64, new_device_signature: &str) -> IntegrationResult<()> {
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        
        // Generate new node identity with migration indicator
        let migration_identity = Self::generate_migration_identity(code, node_type, timestamp, new_device_signature)?;
        let server_ip = Self::get_server_ip();
        
        // Create new state key for migrated device
        let state_key = Self::derive_state_key(code, &migration_identity)?;
        
        // Save with migration binding
        let activation_data = format!("{}:{}:{}:{}:{}:migration:{}", 
            code, node_type, timestamp, migration_identity, server_ip, new_device_signature);
        
        // Encrypt entire record with new state key
        let encrypted_data = Self::encrypt_with_code_key(&activation_data, &state_key)?;
        
        self.db.put_cf(&metadata_cf, b"activation_code", encrypted_data.as_bytes())?;
        self.db.put_cf(&metadata_cf, b"state_key", state_key.as_bytes())?;
        
        println!("✅ Activation code updated for device migration to signature: {}", new_device_signature);
        Ok(())
    }
    
    /// Generate migration identity for device changes
    fn generate_migration_identity(code: &str, node_type: u8, timestamp: u64, new_device_signature: &str) -> IntegrationResult<String> {
        use sha3::{Sha3_256, Digest};
        
        // Identity components for migrated device
        let mut identity_components = Vec::new();
        
        // Core: activation code + migration info
        identity_components.push(code.to_string());
        identity_components.push(format!("node_type:{}", node_type));
        identity_components.push(format!("timestamp:{}", timestamp));
        identity_components.push(format!("device_signature:{}", new_device_signature));
        
        // Add migration marker
        identity_components.push("migration_enabled".to_string());
        
        // Generate deterministic identity from transfer data
        let combined = identity_components.join("|");
        let identity_hash = hex::encode(Sha3_256::digest(combined.as_bytes()));
        
        // Use first 16 characters for transfer identity
        Ok(identity_hash[..16].to_string())
    }
    
    /// Generate cryptographic node identity from activation code (universal device support)
    fn generate_node_identity(code: &str, node_type: u8, timestamp: u64) -> IntegrationResult<String> {
        use sha3::{Sha3_256, Digest};
        
        // Primary components: activation code + node config
        let mut identity_components = Vec::new();
        
        // Core: activation code itself (unique and immutable)
        identity_components.push(code.to_string());
        
        // Node configuration (stable across device migrations)
        identity_components.push(format!("node_type:{}", node_type));
        identity_components.push(format!("timestamp:{}", timestamp));
        
        // Add stable system info (works on all devices: VPS, VDS, PC, laptop, server)
        identity_components.push(format!("user:{}", 
            std::env::var("USER").unwrap_or_else(|_| "qnet".to_string())
        ));
        
        // Add hostname (may change but helps with uniqueness)
        if let Ok(hostname) = std::env::var("HOSTNAME") {
            identity_components.push(format!("hostname:{}", hostname));
        }
        
        // Universal device support: use activation code as primary entropy source
        let primary_hash = hex::encode(Sha3_256::digest(code.as_bytes()));
        identity_components.push(format!("code_hash:{}", &primary_hash[..16]));
        
        // Generate deterministic identity from activation code
        let combined = identity_components.join("|");
        let identity_hash = hex::encode(Sha3_256::digest(combined.as_bytes()));
        
        // Use first 16 characters for node identity
        Ok(identity_hash[..16].to_string())
    }
    
    /// Get server IP address
    fn get_server_ip() -> String {
        use std::process::Command;
        
        // Try to get public IP
        if let Ok(output) = Command::new("curl")
            .arg("-s")
            .arg("--max-time")
            .arg("2")
            .arg("https://api.ipify.org")
            .output() {
            if let Ok(ip) = String::from_utf8(output.stdout) {
                if !ip.trim().is_empty() {
                    return ip.trim().to_string();
                }
            }
        }
        
        // Fallback to local IP
        if let Ok(output) = Command::new("hostname").arg("-I").output() {
            if let Ok(ip) = String::from_utf8(output.stdout) {
                if let Some(first_ip) = ip.split_whitespace().next() {
                    return first_ip.to_string();
                }
            }
        }
        
        "unknown".to_string()
    }
    
    /// Derive state key from activation code and node identity
    fn derive_state_key(code: &str, node_identity: &str) -> IntegrationResult<String> {
        use sha3::{Sha3_256, Digest};
        
        // Create deterministic key from activation code
        let key_material = format!("{}:{}:state_key", code, node_identity);
        let key_hash = hex::encode(Sha3_256::digest(key_material.as_bytes()));
        
        // Use first 32 characters as state key
        Ok(key_hash[..32].to_string())
    }
    
    /// Encrypt data with code-derived key
    fn encrypt_with_code_key(data: &str, state_key: &str) -> IntegrationResult<String> {
        use sha3::{Sha3_256, Digest};
        
        // Create encryption key from state key
        let key_bytes = hex::decode(format!("{:0<32}", state_key))
            .map_err(|e| IntegrationError::SecurityError(format!("Key generation failed: {}", e)))?;
        
        let mut encrypted = Vec::new();
        for (i, byte) in data.as_bytes().iter().enumerate() {
            encrypted.push(byte ^ key_bytes[i % key_bytes.len()]);
        }
        
        Ok(hex::encode(encrypted))
    }
    
    /// Decrypt data with code-derived key
    fn decrypt_with_code_key(encrypted_data: &str, state_key: &str) -> IntegrationResult<String> {
        use sha3::{Sha3_256, Digest};
        
        let encrypted_bytes = hex::decode(encrypted_data)
            .map_err(|e| IntegrationError::SecurityError(format!("Decryption failed: {}", e)))?;
        
        let key_bytes = hex::decode(format!("{:0<32}", state_key))
            .map_err(|e| IntegrationError::SecurityError(format!("Key generation failed: {}", e)))?;
        
        let mut decrypted = Vec::new();
        for (i, byte) in encrypted_bytes.iter().enumerate() {
            decrypted.push(byte ^ key_bytes[i % key_bytes.len()]);
        }
        
        String::from_utf8(decrypted)
            .map_err(|e| IntegrationError::SecurityError(format!("Decryption failed: {}", e)))
    }
    
    pub fn load_microblock(&self, height: u64) -> IntegrationResult<Option<Vec<u8>>> {
        let microblocks_cf = self.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        
        let key = format!("microblock_{}", height);
        match self.db.get_cf(&microblocks_cf, key.as_bytes())? {
            Some(data) => Ok(Some(data)),
            None => Ok(None),
        }
    }
    
    pub fn get_latest_macroblock_hash(&self) -> Result<[u8; 32], IntegrationError> {
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        
        match self.db.get_cf(&metadata_cf, b"latest_macroblock_hash")? {
            Some(data) if data.len() >= 32 => {
                let mut hash = [0u8; 32];
                hash.copy_from_slice(&data[..32]);
                Ok(hash)
            },
            _ => Ok([0u8; 32]), // Default genesis hash
        }
    }
    
    pub async fn save_macroblock(&self, height: u64, macroblock: &qnet_state::MacroBlock) -> IntegrationResult<()> {
        let microblocks_cf = self.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        
        let key = format!("macroblock_{}", height);
        let data = bincode::serialize(macroblock)
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        
        let mut batch = WriteBatch::default();
        batch.put_cf(&microblocks_cf, key.as_bytes(), &data);
        
        // Update latest macroblock hash
        let hash = macroblock.hash();
        batch.put_cf(&metadata_cf, b"latest_macroblock_hash", &hash);
        
        self.db.write(batch)?;
        Ok(())
    }
    
    pub fn get_stats(&self) -> IntegrationResult<StorageStats> {
        let mut stats = StorageStats::default();
        
        // Get chain height
        stats.latest_height = self.get_chain_height()?;
        
        // Count blocks
        let block_cf = self.db.cf_handle("blocks")
            .ok_or_else(|| IntegrationError::StorageError("blocks column family not found".to_string()))?;
        let mut block_count = 0u64;
        let iter = self.db.iterator_cf(&block_cf, rocksdb::IteratorMode::Start);
        for item in iter {
            let (key, _) = item?;
            if std::str::from_utf8(&key).unwrap_or("").starts_with("block_") {
                block_count += 1;
            }
        }
        stats.total_blocks = block_count;
        
        // Count transactions  
        let tx_cf = self.db.cf_handle("transactions")
            .ok_or_else(|| IntegrationError::StorageError("transactions column family not found".to_string()))?;
        let mut tx_count = 0u64;
        let iter = self.db.iterator_cf(&tx_cf, rocksdb::IteratorMode::Start);
        for item in iter {
            let (key, _) = item?;
            if std::str::from_utf8(&key).unwrap_or("").starts_with("tx_") {
                tx_count += 1;
            }
        }
        stats.total_transactions = tx_count;
        
        // Count accounts
        let accounts_cf = self.db.cf_handle("accounts")
            .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;
        let mut account_count = 0u64;
        let iter = self.db.iterator_cf(&accounts_cf, rocksdb::IteratorMode::Start);
        for _item in iter {
            account_count += 1;
        }
        stats.total_accounts = account_count;
        
        Ok(stats)
    }
}

pub struct Storage {
    persistent: PersistentStorage,
}

impl Storage {
    pub fn new(data_dir: &str) -> IntegrationResult<Self> {
        let persistent = PersistentStorage::new(data_dir)?;
        Ok(Self { persistent })
    }
    
    pub fn get_chain_height(&self) -> IntegrationResult<u64> {
        self.persistent.get_chain_height()
    }
    
    pub fn get_block_hash(&self, height: u64) -> IntegrationResult<Option<String>> {
        self.persistent.get_block_hash(height)
    }
    
    pub async fn save_block(&self, block: &qnet_state::Block) -> IntegrationResult<()> {
        self.persistent.save_block(block).await
    }
    
    pub async fn load_block_by_height(&self, height: u64) -> IntegrationResult<Option<qnet_state::Block>> {
        self.persistent.load_block_by_height(height).await
    }
    
    pub fn save_microblock(&self, height: u64, data: &[u8]) -> IntegrationResult<()> {
        self.persistent.save_microblock(height, data)
    }
    
    pub fn load_microblock(&self, height: u64) -> IntegrationResult<Option<Vec<u8>>> {
        self.persistent.load_microblock(height)
    }
    
    pub fn get_latest_macroblock_hash(&self) -> Result<[u8; 32], IntegrationError> {
        self.persistent.get_latest_macroblock_hash()
    }
    
    pub async fn save_macroblock(&self, height: u64, macroblock: &qnet_state::MacroBlock) -> IntegrationResult<()> {
        self.persistent.save_macroblock(height, macroblock).await
    }
    
    pub fn get_stats(&self) -> IntegrationResult<StorageStats> {
        self.persistent.get_stats()
    }

    // Activation code methods
    pub fn save_activation_code(&self, code: &str, node_type: u8, timestamp: u64) -> IntegrationResult<()> {
        self.persistent.save_activation_code(code, node_type, timestamp)
    }

    pub fn load_activation_code(&self) -> IntegrationResult<Option<(String, u8, u64)>> {
        self.persistent.load_activation_code()
    }

    pub fn clear_activation_code(&self) -> IntegrationResult<()> {
        self.persistent.clear_activation_code()
    }

    pub fn update_activation_for_migration(&self, code: &str, node_type: u8, timestamp: u64, new_device_signature: &str) -> IntegrationResult<()> {
        self.persistent.update_activation_for_migration(code, node_type, timestamp, new_device_signature)
    }
} 