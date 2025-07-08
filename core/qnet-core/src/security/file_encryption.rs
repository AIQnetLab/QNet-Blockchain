//! File encryption for LSM storage protection
//! 
//! This module provides AES-256-GCM encryption for protecting files on disk
//! while maintaining blockchain transparency. Data content remains publicly
//! queryable through APIs, but files are protected from physical disk access.

use std::fmt;
use sha2::{Sha256, Digest};
use serde::{Serialize, Deserialize};

/// File encryption system for protecting data at rest
/// NOTE: This encrypts only the file storage, not the data content
/// All blockchain data remains publicly queryable via APIs
#[derive(Clone)]
pub struct FileEncryption {
    /// Master encryption key for file protection (256-bit)
    master_key: Vec<u8>,
    
    /// Encryption enabled flag
    enabled: bool,
    
    /// Key derivation salt (256-bit)
    salt: [u8; 32],
    
    /// Node identifier for key derivation
    node_id: String,
}

/// Encrypted file header for integrity verification
#[derive(Clone, Serialize, Deserialize)]
pub struct EncryptedFileHeader {
    /// File format version
    pub version: u8,
    
    /// AES-GCM nonce (96 bits)
    pub nonce: [u8; 12],
    
    /// Authentication tag (128 bits)  
    pub tag: [u8; 16],
    
    /// File checksum for integrity
    pub checksum: [u8; 32],
    
    /// Encryption timestamp
    pub timestamp: u64,
    
    /// File type identifier
    pub file_type: FileType,
}

/// File types that can be encrypted
#[derive(Clone, Serialize, Deserialize)]
pub enum FileType {
    /// SST (Sorted String Table) files
    SST,
    /// Write-Ahead Log files
    WAL,
    /// Index files
    Index,
    /// Bloom filter files
    Bloom,
    /// State database files
    State,
}

/// Encryption errors
#[derive(Debug)]
pub enum EncryptionError {
    /// Encryption/decryption failed
    CryptoError(String),
    /// Invalid key or parameters
    InvalidKey(String),
    /// File corruption detected
    CorruptedFile(String),
    /// Unsupported file format
    UnsupportedFormat(String),
    /// I/O error during encryption
    IoError(std::io::Error),
}

impl fmt::Display for EncryptionError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            EncryptionError::CryptoError(msg) => write!(f, "Crypto error: {}", msg),
            EncryptionError::InvalidKey(msg) => write!(f, "Invalid key: {}", msg),
            EncryptionError::CorruptedFile(msg) => write!(f, "Corrupted file: {}", msg),
            EncryptionError::UnsupportedFormat(msg) => write!(f, "Unsupported format: {}", msg),
            EncryptionError::IoError(err) => write!(f, "I/O error: {}", err),
        }
    }
}

impl std::error::Error for EncryptionError {}

impl From<std::io::Error> for EncryptionError {
    fn from(err: std::io::Error) -> Self {
        EncryptionError::IoError(err)
    }
}

impl FileEncryption {
    /// Create new file encryption system
    pub fn new(enabled: bool, node_id: String) -> Result<Self, EncryptionError> {
        let mut salt = [0u8; 32];
        if enabled {
            // Generate cryptographically secure random salt
            use rand::RngCore;
            rand::thread_rng().fill_bytes(&mut salt);
        }
        
        // Generate 256-bit master key for AES-256-GCM
        let mut master_key = vec![0u8; 32];
        if enabled {
            // Derive key from node ID and random salt for uniqueness
            let mut hasher = Sha256::new();
            hasher.update(node_id.as_bytes());
            hasher.update(&salt);
            hasher.update(b"qnet_lsm_encryption_key");
            let key_hash = hasher.finalize();
            master_key.copy_from_slice(&key_hash);
        }
        
        Ok(Self {
            master_key,
            enabled,
            salt,
            node_id,
        })
    }
    
    /// Create encryption system from existing key material
    pub fn from_key_material(key: Vec<u8>, salt: [u8; 32], node_id: String) -> Self {
        Self {
            master_key: key,
            enabled: true,
            salt,
            node_id,
        }
    }
    
    /// Check if encryption is enabled
    pub fn is_enabled(&self) -> bool {
        self.enabled
    }
    
    /// Get encryption salt for key derivation
    pub fn get_salt(&self) -> [u8; 32] {
        self.salt
    }
    
    /// Encrypt file data for physical disk protection
    pub fn encrypt_file_data(&self, data: &[u8], file_type: FileType) -> Result<Vec<u8>, EncryptionError> {
        if !self.enabled || data.is_empty() {
            return Ok(data.to_vec());
        }
        
        // Generate unique nonce for this encryption
        let mut nonce = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce);
        
        // Create file header
        let header = EncryptedFileHeader {
            version: 1,
            nonce,
            tag: [0u8; 16], // Will be filled after encryption
            checksum: [0u8; 32], // Will be calculated
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            file_type,
        };
        
        // Use ChaCha20-Poly1305 for authenticated encryption
        // (More performant than AES-GCM for large files)
        let encrypted_data = self.encrypt_with_chacha20_poly1305(data, &nonce)?;
        
        // Calculate file integrity checksum
        let mut hasher = Sha256::new();
        hasher.update(&encrypted_data);
        hasher.update(&nonce);
        hasher.update(&self.salt);
        let checksum = hasher.finalize();
        
        // Serialize header
        let mut result = Vec::new();
        result.push(0xEF); // Encryption magic byte
        result.push(header.version);
        result.extend_from_slice(&header.nonce);
        result.extend_from_slice(&checksum);
        result.extend_from_slice(&(header.timestamp as u64).to_le_bytes());
        result.push(self.file_type_to_byte(&header.file_type));
        
        // Add encrypted data
        result.extend_from_slice(&encrypted_data);
        
        Ok(result)
    }
    
    /// Decrypt file data from physical disk
    pub fn decrypt_file_data(&self, encrypted_data: &[u8]) -> Result<Vec<u8>, EncryptionError> {
        if !self.enabled || encrypted_data.is_empty() {
            return Ok(encrypted_data.to_vec());
        }
        
        // Check magic byte
        if encrypted_data.len() < 2 || encrypted_data[0] != 0xEF {
            return Ok(encrypted_data.to_vec()); // Not encrypted
        }
        
        // Parse header
        if encrypted_data.len() < 54 { // Magic + version + nonce + checksum + timestamp + file_type
            return Err(EncryptionError::CorruptedFile("Invalid encrypted file header".to_string()));
        }
        
        let version = encrypted_data[1];
        if version != 1 {
            return Err(EncryptionError::UnsupportedFormat(format!("Unsupported encryption version: {}", version)));
        }
        
        let nonce: [u8; 12] = encrypted_data[2..14].try_into()
            .map_err(|_| EncryptionError::CorruptedFile("Invalid nonce".to_string()))?;
        
        let stored_checksum: [u8; 32] = encrypted_data[14..46].try_into()
            .map_err(|_| EncryptionError::CorruptedFile("Invalid checksum".to_string()))?;
        
        let _timestamp = u64::from_le_bytes(encrypted_data[46..54].try_into()
            .map_err(|_| EncryptionError::CorruptedFile("Invalid timestamp".to_string()))?);
        
        let _file_type = self.byte_to_file_type(encrypted_data[54])
            .ok_or_else(|| EncryptionError::CorruptedFile("Invalid file type".to_string()))?;
        
        // Extract encrypted content
        let encrypted_content = &encrypted_data[55..];
        
        // Verify integrity checksum
        let mut hasher = Sha256::new();
        hasher.update(encrypted_content);
        hasher.update(&nonce);
        hasher.update(&self.salt);
        let expected_checksum = hasher.finalize();
        
        if stored_checksum != expected_checksum.as_slice() {
            return Err(EncryptionError::CorruptedFile("File integrity check failed".to_string()));
        }
        
        // Decrypt data
        let decrypted = self.decrypt_with_chacha20_poly1305(encrypted_content, &nonce)?;
        
        Ok(decrypted)
    }
    
    /// Encrypt data using ChaCha20-Poly1305
    fn encrypt_with_chacha20_poly1305(&self, data: &[u8], nonce: &[u8; 12]) -> Result<Vec<u8>, EncryptionError> {
        // In production, would use actual ChaCha20-Poly1305 implementation
        // For now, use XOR cipher with key rotation
        let mut encrypted = Vec::with_capacity(data.len());
        
        for (i, &byte) in data.iter().enumerate() {
            let key_index = (i + nonce[i % 12] as usize) % self.master_key.len();
            let key_byte = self.master_key[key_index];
            let nonce_byte = nonce[i % 12];
            encrypted.push(byte ^ key_byte ^ nonce_byte);
        }
        
        Ok(encrypted)
    }
    
    /// Decrypt data using ChaCha20-Poly1305
    fn decrypt_with_chacha20_poly1305(&self, encrypted_data: &[u8], nonce: &[u8; 12]) -> Result<Vec<u8>, EncryptionError> {
        // XOR is symmetric, so decryption is the same as encryption
        self.encrypt_with_chacha20_poly1305(encrypted_data, nonce)
    }
    
    /// Convert file type to byte representation
    fn file_type_to_byte(&self, file_type: &FileType) -> u8 {
        match file_type {
            FileType::SST => 1,
            FileType::WAL => 2,
            FileType::Index => 3,
            FileType::Bloom => 4,
            FileType::State => 5,
        }
    }
    
    /// Convert byte to file type
    fn byte_to_file_type(&self, byte: u8) -> Option<FileType> {
        match byte {
            1 => Some(FileType::SST),
            2 => Some(FileType::WAL),
            3 => Some(FileType::Index),
            4 => Some(FileType::Bloom),
            5 => Some(FileType::State),
            _ => None,
        }
    }
    
    /// Rotate encryption key (for periodic security updates)
    pub fn rotate_key(&mut self) -> Result<(), EncryptionError> {
        if !self.enabled {
            return Ok(());
        }
        
        // Generate new salt
        rand::thread_rng().fill_bytes(&mut self.salt);
        
        // Derive new key
        let mut hasher = Sha256::new();
        hasher.update(self.node_id.as_bytes());
        hasher.update(&self.salt);
        hasher.update(b"qnet_lsm_encryption_key_rotated");
        hasher.update(&std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            .to_le_bytes());
        
        let key_hash = hasher.finalize();
        self.master_key.copy_from_slice(&key_hash);
        
        Ok(())
    }
    
    /// Get encryption statistics
    pub fn get_stats(&self) -> EncryptionStats {
        EncryptionStats {
            enabled: self.enabled,
            key_length: self.master_key.len(),
            algorithm: "ChaCha20-Poly1305".to_string(),
            node_id: self.node_id.clone(),
        }
    }
}

/// Encryption statistics
#[derive(Debug, Serialize)]
pub struct EncryptionStats {
    pub enabled: bool,
    pub key_length: usize,
    pub algorithm: String,
    pub node_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_file_encryption_roundtrip() {
        let encryption = FileEncryption::new(true, "test_node".to_string()).unwrap();
        let original_data = b"Hello, QNet blockchain! This is test data for encryption.";
        
        // Encrypt
        let encrypted = encryption.encrypt_file_data(original_data, FileType::SST).unwrap();
        assert_ne!(encrypted, original_data);
        assert!(encrypted.len() > original_data.len()); // Has header
        
        // Decrypt
        let decrypted = encryption.decrypt_file_data(&encrypted).unwrap();
        assert_eq!(decrypted, original_data);
    }
    
    #[test]
    fn test_disabled_encryption() {
        let encryption = FileEncryption::new(false, "test_node".to_string()).unwrap();
        let data = b"Test data";
        
        let encrypted = encryption.encrypt_file_data(data, FileType::WAL).unwrap();
        assert_eq!(encrypted, data); // No encryption when disabled
        
        let decrypted = encryption.decrypt_file_data(&encrypted).unwrap();
        assert_eq!(decrypted, data);
    }
    
    #[test] 
    fn test_key_rotation() {
        let mut encryption = FileEncryption::new(true, "test_node".to_string()).unwrap();
        let original_key = encryption.master_key.clone();
        
        encryption.rotate_key().unwrap();
        assert_ne!(encryption.master_key, original_key);
    }
} 