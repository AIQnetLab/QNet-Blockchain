//! Security module for QNet blockchain
//! 
//! This module provides comprehensive security features:
//! - File encryption for physical disk protection
//! - TLS configuration for secure communications
//! - Access control and authentication
//! - API authorization and rate limiting

pub mod file_encryption;

pub use file_encryption::*;

/// Security configuration for QNet node
#[derive(Clone)]
pub struct SecurityConfig {
    /// Enable file encryption for LSM storage
    pub enable_file_encryption: bool,
    
    /// Enable TLS for API endpoints
    pub enable_tls: bool,
    
    /// TLS certificate path
    pub tls_cert_path: Option<String>,
    
    /// TLS private key path
    pub tls_key_path: Option<String>,
    
    /// Enable access control for admin endpoints
    pub enable_access_control: bool,
    
    /// API key for administrative access
    pub admin_api_key: Option<String>,
    
    /// Rate limiting settings
    pub rate_limit_requests_per_minute: u32,
    
    /// Node identifier for key derivation
    pub node_id: String,
}

impl Default for SecurityConfig {
    fn default() -> Self {
        Self {
            enable_file_encryption: true,  // Default enabled for production
            enable_tls: true,             // Default enabled for production
            tls_cert_path: None,
            tls_key_path: None,
            enable_access_control: true,  // Default enabled for production
            admin_api_key: None,
            rate_limit_requests_per_minute: 1000,
            node_id: "default_node".to_string(),
        }
    }
}

impl SecurityConfig {
    /// Create production security configuration
    pub fn production(node_id: String) -> Self {
        Self {
            enable_file_encryption: true,
            enable_tls: true,
            tls_cert_path: Some("/etc/qnet/tls/cert.pem".to_string()),
            tls_key_path: Some("/etc/qnet/tls/key.pem".to_string()),
            enable_access_control: true,
            admin_api_key: None, // Should be set via environment variable
            rate_limit_requests_per_minute: 1000,
            node_id,
        }
    }
    
    /// Create development security configuration (less strict)
    pub fn development(node_id: String) -> Self {
        Self {
            enable_file_encryption: false, // Disabled for dev convenience
            enable_tls: false,            // Disabled for dev convenience
            tls_cert_path: None,
            tls_key_path: None,
            enable_access_control: false, // Disabled for dev convenience
            admin_api_key: Some("dev_admin_key_12345".to_string()),
            rate_limit_requests_per_minute: 10000, // Higher limit for dev
            node_id,
        }
    }
    
    /// Validate security configuration
    pub fn validate(&self) -> Result<(), SecurityError> {
        if self.enable_tls {
            if self.tls_cert_path.is_none() || self.tls_key_path.is_none() {
                return Err(SecurityError::InvalidConfig(
                    "TLS enabled but certificate/key paths not specified".to_string()
                ));
            }
        }
        
        if self.enable_access_control && self.admin_api_key.is_none() {
            return Err(SecurityError::InvalidConfig(
                "Access control enabled but admin API key not specified".to_string()
            ));
        }
        
        if self.rate_limit_requests_per_minute == 0 {
            return Err(SecurityError::InvalidConfig(
                "Rate limit cannot be zero".to_string()
            ));
        }
        
        Ok(())
    }
}

/// Security errors
#[derive(Debug)]
pub enum SecurityError {
    /// Invalid security configuration
    InvalidConfig(String),
    /// Authentication failed
    AuthenticationFailed(String),
    /// Authorization denied
    AuthorizationDenied(String),
    /// Rate limit exceeded
    RateLimitExceeded(String),
    /// TLS error
    TlsError(String),
    /// Encryption error
    EncryptionError(String),
}

impl std::fmt::Display for SecurityError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            SecurityError::InvalidConfig(msg) => write!(f, "Invalid config: {}", msg),
            SecurityError::AuthenticationFailed(msg) => write!(f, "Authentication failed: {}", msg),
            SecurityError::AuthorizationDenied(msg) => write!(f, "Authorization denied: {}", msg),
            SecurityError::RateLimitExceeded(msg) => write!(f, "Rate limit exceeded: {}", msg),
            SecurityError::TlsError(msg) => write!(f, "TLS error: {}", msg),
            SecurityError::EncryptionError(msg) => write!(f, "Encryption error: {}", msg),
        }
    }
}

impl std::error::Error for SecurityError {} 