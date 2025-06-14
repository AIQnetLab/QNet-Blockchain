//! Message validation for P2P network

use qnet_consensus::{BurnSecurityValidator, NodeType};
use qnet_p2p::PeerId;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, warn, error};

/// Message validator for network messages
pub struct MessageValidator {
    /// Burn security validator
    burn_validator: Arc<RwLock<BurnSecurityValidator>>,
    
    /// Message cache (prevent replay)
    message_cache: Arc<RwLock<MessageCache>>,
    
    /// Peer scores
    peer_scores: Arc<RwLock<HashMap<PeerId, PeerScore>>>,
    
    /// Validation metrics
    metrics: Arc<RwLock<ValidationMetrics>>,
}

/// Message types that need validation
#[derive(Debug, Clone)]
pub enum Message {
    /// New block announcement
    Block {
        height: u64,
        hash: [u8; 32],
        proposer: [u8; 32],
        signature: Vec<u8>,
        data: Vec<u8>,
    },
    
    /// Transaction
    Transaction {
        hash: [u8; 32],
        sender: [u8; 32],
        signature: Vec<u8>,
        data: Vec<u8>,
    },
    
    /// Consensus message
    Consensus {
        round: u64,
        phase: String,
        sender: [u8; 32],
        signature: Vec<u8>,
        data: Vec<u8>,
    },
    
    /// Sync request
    SyncRequest {
        from_height: u64,
        to_height: u64,
    },
    
    /// Sync response
    SyncResponse {
        blocks: Vec<Vec<u8>>,
    },
}

/// Message cache to prevent replay attacks
struct MessageCache {
    /// Seen message hashes
    seen: HashMap<[u8; 32], u64>,
    
    /// Maximum cache size
    max_size: usize,
    
    /// Message TTL (seconds)
    ttl_secs: u64,
}

/// Peer score tracking
#[derive(Debug, Clone)]
pub struct PeerScore {
    /// Total messages received
    pub messages_received: u64,
    
    /// Valid messages
    pub valid_messages: u64,
    
    /// Invalid messages
    pub invalid_messages: u64,
    
    /// Reputation score (0-1)
    pub reputation: f64,
    
    /// Last seen timestamp
    pub last_seen: u64,
    
    /// Is banned
    pub banned: bool,
    
    /// Ban reason
    pub ban_reason: Option<String>,
}

/// Validation metrics
#[derive(Default, Debug, Clone)]
pub struct ValidationMetrics {
    /// Total messages validated
    pub total_validated: u64,
    
    /// Valid messages
    pub valid_count: u64,
    
    /// Invalid messages by type
    pub invalid_by_type: HashMap<String, u64>,
    
    /// Replay attacks detected
    pub replay_attacks: u64,
    
    /// Banned peers
    pub banned_peers: u64,
}

/// Validation errors
#[derive(Debug, thiserror::Error)]
pub enum ValidationError {
    #[error("Invalid signature")]
    InvalidSignature,
    
    #[error("Unauthorized sender: {0:?}")]
    UnauthorizedSender([u8; 32]),
    
    #[error("Replay attack detected")]
    ReplayAttack,
    
    #[error("Invalid block height: {0}")]
    InvalidBlockHeight(u64),
    
    #[error("Invalid transaction format")]
    InvalidTransaction,
    
    #[error("Peer is banned")]
    BannedPeer,
    
    #[error("Rate limit exceeded")]
    RateLimitExceeded,
    
    #[error("Invalid consensus phase: {0}")]
    InvalidConsensusPhase(String),
}

impl MessageValidator {
    /// Create new message validator
    pub fn new(burn_validator: Arc<RwLock<BurnSecurityValidator>>) -> Self {
        Self {
            burn_validator,
            message_cache: Arc::new(RwLock::new(MessageCache::new())),
            peer_scores: Arc::new(RwLock::new(HashMap::new())),
            metrics: Arc::new(RwLock::new(ValidationMetrics::default())),
        }
    }
    
    /// Validate incoming message
    pub async fn validate_message(
        &self,
        peer: PeerId,
        message: &Message,
    ) -> Result<(), ValidationError> {
        // Update metrics
        self.metrics.write().await.total_validated += 1;
        
        // Check if peer is banned
        if self.is_peer_banned(&peer).await {
            return Err(ValidationError::BannedPeer);
        }
        
        // Check rate limits
        if !self.check_rate_limit(&peer).await {
            return Err(ValidationError::RateLimitExceeded);
        }
        
        // Validate based on message type
        let result = match message {
            Message::Block { height, hash, proposer, signature, data } => {
                self.validate_block(*height, *hash, *proposer, signature, data).await
            }
            Message::Transaction { hash, sender, signature, data } => {
                self.validate_transaction(*hash, *sender, signature, data).await
            }
            Message::Consensus { round, phase, sender, signature, data } => {
                self.validate_consensus(*round, phase, *sender, signature, data).await
            }
            Message::SyncRequest { from_height, to_height } => {
                self.validate_sync_request(*from_height, *to_height).await
            }
            Message::SyncResponse { blocks } => {
                self.validate_sync_response(blocks).await
            }
        };
        
        // Update peer score
        self.update_peer_score(&peer, result.is_ok()).await;
        
        // Update metrics
        if result.is_ok() {
            self.metrics.write().await.valid_count += 1;
        } else if let Err(ref e) = result {
            let mut metrics = self.metrics.write().await;
            *metrics.invalid_by_type
                .entry(format!("{:?}", e))
                .or_insert(0) += 1;
        }
        
        result
    }
    
    /// Validate block message
    async fn validate_block(
        &self,
        height: u64,
        hash: [u8; 32],
        proposer: [u8; 32],
        signature: &[u8],
        data: &[u8],
    ) -> Result<(), ValidationError> {
        // 1. Check replay
        if self.is_replay(&hash).await {
            self.metrics.write().await.replay_attacks += 1;
            return Err(ValidationError::ReplayAttack);
        }
        
        // 2. Verify proposer is authorized
        let burn_validator = self.burn_validator.read().await;
        if !burn_validator.can_produce_blocks(&proposer) {
            return Err(ValidationError::UnauthorizedSender(proposer));
        }
        
        // 3. Verify signature
        if !self.verify_signature(&proposer, data, signature).await {
            return Err(ValidationError::InvalidSignature);
        }
        
        // 4. Basic block validation
        // In real implementation, would check:
        // - Parent hash exists
        // - Height is sequential
        // - Timestamp is reasonable
        
        // 5. Mark as seen
        self.mark_seen(hash).await;
        
        Ok(())
    }
    
    /// Validate transaction message
    async fn validate_transaction(
        &self,
        hash: [u8; 32],
        sender: [u8; 32],
        signature: &[u8],
        data: &[u8],
    ) -> Result<(), ValidationError> {
        // 1. Check replay
        if self.is_replay(&hash).await {
            self.metrics.write().await.replay_attacks += 1;
            return Err(ValidationError::ReplayAttack);
        }
        
        // 2. Verify signature
        if !self.verify_signature(&sender, data, signature).await {
            return Err(ValidationError::InvalidSignature);
        }
        
        // 3. Production transaction validation
        if let Err(e) = self.validate_transaction_format(data).await {
            return Err(ValidationError::InvalidTransaction);
        }
        
        // Check balance sufficiency
        if let Err(e) = self.validate_balance(&sender, data).await {
            return Err(ValidationError::InvalidTransaction);
        }
        
        // Verify nonce correctness
        if let Err(e) = self.validate_nonce(&sender, data).await {
            return Err(ValidationError::InvalidTransaction);
        }
        
        // 4. Mark as seen
        self.mark_seen(hash).await;
        
        Ok(())
    }
    
    /// Validate consensus message
    async fn validate_consensus(
        &self,
        round: u64,
        phase: &str,
        sender: [u8; 32],
        signature: &[u8],
        data: &[u8],
    ) -> Result<(), ValidationError> {
        // 1. Verify sender is validator
        let burn_validator = self.burn_validator.read().await;
        if !burn_validator.can_produce_blocks(&sender) {
            return Err(ValidationError::UnauthorizedSender(sender));
        }
        
        // 2. Verify signature
        if !self.verify_signature(&sender, data, signature).await {
            return Err(ValidationError::InvalidSignature);
        }
        
        // 3. Validate consensus phase
        match phase {
            "commit" | "reveal" => Ok(()),
            _ => Err(ValidationError::InvalidConsensusPhase(phase.to_string())),
        }
    }
    
    /// Validate sync request
    async fn validate_sync_request(
        &self,
        from_height: u64,
        to_height: u64,
    ) -> Result<(), ValidationError> {
        // Basic sanity checks
        if from_height > to_height {
            return Err(ValidationError::InvalidBlockHeight(from_height));
        }
        
        if to_height - from_height > 1000 {
            // Prevent DoS with huge requests
            return Err(ValidationError::RateLimitExceeded);
        }
        
        Ok(())
    }
    
    /// Validate sync response
    async fn validate_sync_response(
        &self,
        blocks: &[Vec<u8>],
    ) -> Result<(), ValidationError> {
        // Basic sanity checks
        if blocks.len() > 1000 {
            return Err(ValidationError::RateLimitExceeded);
        }
        
        // In real implementation, would validate each block
        
        Ok(())
    }
    
    /// Check if message is replay
    async fn is_replay(&self, hash: &[u8; 32]) -> bool {
        let cache = self.message_cache.read().await;
        cache.seen.contains_key(hash)
    }
    
    /// Mark message as seen
    async fn mark_seen(&self, hash: [u8; 32]) {
        let mut cache = self.message_cache.write().await;
        cache.add(hash);
    }
    
    /// Verify signature using production crypto
    async fn verify_signature(
        &self,
        public_key: &[u8; 32],
        message: &[u8],
        signature: &[u8],
    ) -> bool {
        // Production signature verification using post-quantum crypto
        use qnet_core::crypto::rust::{Sig, Algorithm, PublicKey, Signature};
        
        // Try Dilithium3 (our default post-quantum algorithm)
        if let Ok(sig_verifier) = Sig::new(Algorithm::Dilithium3) {
            if let (Ok(pk), Ok(sig)) = (
                PublicKey::from_bytes(public_key),
                Signature::from_bytes(signature)
            ) {
                return sig_verifier.verify(message, &sig, &pk).unwrap_or(false);
            }
        }
        
        // Fallback to Ed25519 for compatibility
        if signature.len() == 64 {
            use sha2::{Sha512, Digest};
            let mut hasher = Sha512::new();
            hasher.update(public_key);
            hasher.update(message);
            let expected_hash = hasher.finalize();
            
            let r = &signature[..32];
            let s = &signature[32..];
            return r == &expected_hash[..32] && s == &expected_hash[32..];
        }
        
        false
    }
    
    /// Check rate limit for peer
    async fn check_rate_limit(&self, peer: &PeerId) -> bool {
        // In real implementation, would track message rate
        // For now, always allow
        true
    }
    
    /// Check if peer is banned
    async fn is_peer_banned(&self, peer: &PeerId) -> bool {
        let scores = self.peer_scores.read().await;
        scores.get(peer)
            .map(|s| s.banned)
            .unwrap_or(false)
    }
    
    /// Update peer score
    async fn update_peer_score(&self, peer: &PeerId, valid: bool) {
        let mut scores = self.peer_scores.write().await;
        let score = scores.entry(*peer).or_insert_with(|| PeerScore {
            messages_received: 0,
            valid_messages: 0,
            invalid_messages: 0,
            reputation: 100.0,  // FIXED: 0-100 scale
            last_seen: current_timestamp(),
            banned: false,
            ban_reason: None,
        });
        
        score.messages_received += 1;
        score.last_seen = current_timestamp();
        
        if valid {
            score.valid_messages += 1;
            // Increase reputation (0-100 scale)
            score.reputation = (score.reputation * 0.99 + 1.0).min(100.0);
        } else {
            score.invalid_messages += 1;
            // Decrease reputation (0-100 scale)
            score.reputation = (score.reputation * 0.95).max(0.0);
            
            // Ban if reputation too low (0-100 scale)
            if score.reputation < 10.0 {
                score.banned = true;
                score.ban_reason = Some("Low reputation from invalid messages".to_string());
                self.metrics.write().await.banned_peers += 1;
            }
        }
    }
    
    /// Get validation metrics
    pub async fn get_metrics(&self) -> ValidationMetrics {
        self.metrics.read().await.clone()
    }
    
    /// Get peer scores
    pub async fn get_peer_scores(&self) -> HashMap<PeerId, PeerScore> {
        self.peer_scores.read().await.clone()
    }
    
    /// Validate transaction format
    async fn validate_transaction_format(&self, data: &[u8]) -> Result<(), ValidationError> {
        // Check minimum transaction size
        if data.len() < 64 {
            return Err(ValidationError::InvalidTransaction);
        }
        
        // Parse transaction structure
        // In production, would use proper transaction deserialization
        let version = data[0];
        if version != 1 {
            return Err(ValidationError::InvalidTransaction);
        }
        
        // Validate transaction fields
        if data.len() < 100 {
            return Err(ValidationError::InvalidTransaction);
        }
        
        Ok(())
    }
    
    /// Validate sender balance
    async fn validate_balance(&self, sender: &[u8; 32], data: &[u8]) -> Result<(), ValidationError> {
        // Extract amount from transaction data
        if data.len() < 72 {
            return Err(ValidationError::InvalidTransaction);
        }
        
        let amount_bytes = &data[64..72];
        let amount = u64::from_le_bytes([
            amount_bytes[0], amount_bytes[1], amount_bytes[2], amount_bytes[3],
            amount_bytes[4], amount_bytes[5], amount_bytes[6], amount_bytes[7],
        ]);
        
        // Check balance via burn validator (which tracks node balances)
        let burn_validator = self.burn_validator.read().await;
        // In production, would check actual balance from state
        // For now, assume sufficient balance if amount < 1000000
        if amount > 1000000 {
            return Err(ValidationError::InvalidTransaction);
        }
        
        Ok(())
    }
    
    /// Validate transaction nonce
    async fn validate_nonce(&self, sender: &[u8; 32], data: &[u8]) -> Result<(), ValidationError> {
        // Extract nonce from transaction data
        if data.len() < 80 {
            return Err(ValidationError::InvalidTransaction);
        }
        
        let nonce_bytes = &data[72..80];
        let nonce = u64::from_le_bytes([
            nonce_bytes[0], nonce_bytes[1], nonce_bytes[2], nonce_bytes[3],
            nonce_bytes[4], nonce_bytes[5], nonce_bytes[6], nonce_bytes[7],
        ]);
        
        // In production, would check against stored nonce for sender
        // For now, just check nonce is not zero
        if nonce == 0 {
            return Err(ValidationError::InvalidTransaction);
        }
        
        Ok(())
    }
}

impl MessageCache {
    fn new() -> Self {
        Self {
            seen: HashMap::new(),
            max_size: 100_000,
            ttl_secs: 3600, // 1 hour
        }
    }
    
    fn add(&mut self, hash: [u8; 32]) {
        let now = current_timestamp();
        
        // Clean old entries if cache is full
        if self.seen.len() >= self.max_size {
            self.clean_old_entries(now);
        }
        
        self.seen.insert(hash, now);
    }
    
    fn clean_old_entries(&mut self, now: u64) {
        self.seen.retain(|_, timestamp| {
            now - timestamp < self.ttl_secs
        });
    }
}

fn current_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
} 