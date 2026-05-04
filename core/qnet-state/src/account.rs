//! Account management and state

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Account address type
pub type Address = String;

/// Token amount type
pub type Amount = u64;

/// Account in the blockchain
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub address: String,
    pub balance: u64,
    pub nonce: u64,
    pub is_node: bool,
    pub node_type: Option<String>,

    pub reputation: f64,
    pub created_at: u64,
    pub updated_at: u64,
    
    // v2.96: CRITICAL SECURITY FIX - Store pending rewards in blockchain!
    // This prevents manipulation of local RocksDB to claim fraudulent rewards
    // All nodes can validate RewardDistribution TXs against this on-chain value
    // CRITICAL: #[serde(default)] is MANDATORY for backward compatibility with old blocks!
    #[serde(default)]
    pub pending_rewards: u64,

    // v3.35: Smart contract support -- store contract code hash and metadata
    // is_contract = true when account is a deployed contract
    // contract_code_hash: SHA3-256 of deployed WASM bytecode (stored in storage separately)
    // contract_storage: key-value storage for contract state
    #[serde(default)]
    pub is_contract: bool,
    #[serde(default)]
    pub contract_code_hash: Option<String>,
    #[serde(default)]
    pub contract_storage: HashMap<String, String>,

    // ═══════════════════════════════════════════════════════════════════════════
    // POST-QUANTUM ENFORCEMENT (per-wallet opt-in, two-field design)
    // ═══════════════════════════════════════════════════════════════════════════
    //
    // FIELD 1: `require_pq_signature` (gate flag)
    //   When `true`, every non-system transaction from this account MUST carry
    //   a valid Dilithium3 (ML-DSA-65) signature. Transactions without one are
    //   rejected at apply time, preventing forged TXs even after a CRQC breaks
    //   classical ECC.
    //
    // FIELD 2: `dilithium_public_key` (registered key binding)
    //   The Dilithium3 (ML-DSA-65) public key that the account holder
    //   committed to at the moment of upgrade. Stored as hex (3904 chars,
    //   1952 bytes decoded). All future hybrid TXs from this account MUST
    //   present a Dilithium3 signature verifiable under THIS exact public key.
    //
    //   WITHOUT this binding the gate is bypassable: an attacker with a
    //   forged Ed25519 sig could simply attach their OWN Dilithium3 keypair
    //   to the TX (each TX is currently self-contained for sig verification).
    //   The TX would pass the "has_dilithium" check while the attacker did
    //   not actually compromise the holder's Dilithium3 key.
    //
    //   By binding the registered key into the account, every hybrid TX from
    //   a locked account must verify under the SAME Dilithium3 public key the
    //   holder committed during upgrade. An attacker would need to compromise
    //   THAT specific lattice key — which CRQC cannot do (Dilithium3 is
    //   quantum-resistant by construction, unaffected by Shor's algorithm).
    //
    // SEMANTICS — ONE-WAY UPGRADE
    //   * `require_pq_signature` transitions `false → true` and never reverses.
    //   * `dilithium_public_key` is set ONCE at upgrade time and is immutable
    //     thereafter. Key rotation (if needed) goes through the network-level
    //     KeyRotation TX path with old-key authorisation.
    //
    // ESTABLISHMENT
    //   Set via `SetPQRequirement` transaction signed with BOTH Ed25519 and
    //   Dilithium3 (dual-signature requirement proves the holder owns both
    //   keypairs at the moment of upgrade). The Dilithium3 public key on the
    //   upgrade TX becomes the registered key for the account.
    //
    // SCALABILITY (thousands of validators)
    //   * Zero impact on accounts that don't opt in.
    //   * Adds one hex-string compare (~50 ns) per TX from a locked account.
    //   * Adds one O(1) HashMap lookup per non-system TX (fetch sender Account).
    //   * No network-wide load increase — all checks are local to the
    //     applying node.
    //
    // SECURITY ANALYSIS
    //   * Pre-CRQC era (today): no operational difference for unflagged
    //     accounts. Flag accounts pay one extra Dilithium3 verify per TX
    //     (~3 ms) — same cost as voluntary hybrid signing today.
    //   * Post-CRQC era: forged Ed25519 sigs alone CANNOT spend a flagged
    //     account because the attacker would also need to forge a Dilithium3
    //     signature verifiable under the holder's REGISTERED Dilithium3
    //     public key — quantum-resistant by construction.
    //   * "Harvest now, decrypt later": flagged accounts are immune. An
    //     adversary recording today's traffic and decrypting it under a
    //     future CRQC cannot replay or forge TXs from these accounts because
    //     the Dilithium3 binding remains unbroken.
    #[serde(default)]
    pub require_pq_signature: bool,

    /// Registered Dilithium3 (ML-DSA-65) public key for this account, hex-encoded
    /// (3904 chars / 1952 bytes). Set once via `SetPQRequirement`; immutable
    /// thereafter. `None` until the wallet opts into post-quantum enforcement.
    #[serde(default)]
    pub dilithium_public_key: Option<String>,
}

/// Account state (alias for compatibility)
pub type AccountState = Account;

/// Account metadata
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AccountMetadata {
    /// Creation timestamp
    pub created_at: u64,
    
    /// Last update timestamp
    pub updated_at: u64,
    
    /// Tags for indexing
    pub tags: Vec<String>,
    
    /// Custom properties
    pub properties: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
/// v3.18: Full node type REMOVED - only Light and Super remain
pub enum NodeType {
    Light,
    Super,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ActivationPhase {
    /// Phase 1 – 1DEV burn (external Solana token)
    Phase1,
    /// Phase 2 – QNC transferred to Pool 3 for redistribution (not burned)
    Phase2,
}

impl Default for AccountState {
    fn default() -> Self {
        Self {
            address: String::new(),
            balance: 0,
            nonce: 0,
            is_node: false,
            node_type: None,

            reputation: 0.0,
            created_at: 0,
            updated_at: 0,
            pending_rewards: 0,
            is_contract: false,
            contract_code_hash: None,
            contract_storage: HashMap::new(),
            require_pq_signature: false,
            dilithium_public_key: None,
        }
    }
}

impl AccountState {
    
    /// Check if account is a smart contract (has deployed code)
    pub fn is_smart_contract(&self) -> bool {
        self.is_contract && self.contract_code_hash.is_some()
    }
    
    /// Check if account is a node
    pub fn is_node(&self) -> bool {
        self.is_node
    }
    
    /// Get node type if account is a node
    pub fn node_type(&self) -> Option<&String> {
        self.node_type.as_ref()
    }
    
    /// Transfer amount from this account
    pub fn transfer_out(&mut self, amount: Amount) -> Result<(), String> {
        if self.balance < amount {
            return Err(format!(
                "Insufficient balance: {} < {}",
                self.balance, amount
            ));
        }
        self.balance -= amount;
        self.nonce += 1;
        Ok(())
    }
    
    /// Transfer amount to this account
    pub fn transfer_in(&mut self, amount: Amount) {
        self.balance += amount;
    }
    
    /// Activate as node
    pub fn activate_node(
        &mut self,
        node_type: String,
        timestamp: u64,
    ) {
        self.is_node = true;
        self.node_type = Some(node_type);
        self.updated_at = timestamp;
    }
}

impl Account {
    /// Create new account
    pub fn new(address: Address) -> Self {
        Self {
            address,
            balance: 0,
            nonce: 0,
            is_node: false,
            node_type: None,

            reputation: 0.0,
            created_at: 0,
            updated_at: 0,
            pending_rewards: 0,
            is_contract: false,
            contract_code_hash: None,
            contract_storage: HashMap::new(),
            require_pq_signature: false,
            dilithium_public_key: None,
        }
    }

    /// Create account with initial balance
    pub fn with_balance(address: Address, balance: Amount) -> Self {
        Self {
            address,
            balance,
            nonce: 0,
            is_node: false,
            node_type: None,

            reputation: 0.0,
            created_at: 0,
            updated_at: 0,
            pending_rewards: 0,
            is_contract: false,
            contract_code_hash: None,
            contract_storage: HashMap::new(),
            require_pq_signature: false,
            dilithium_public_key: None,
        }
    }

    /// Update metadata timestamp
    pub fn touch(&mut self, timestamp: u64) {
        if self.created_at == 0 {
            self.created_at = timestamp;
        }
        self.updated_at = timestamp;
    }

    /// Check whether this account requires post-quantum (Dilithium3) signatures.
    /// One-way upgrade: once true, cannot be set false.
    pub fn requires_pq_signature(&self) -> bool {
        self.require_pq_signature
    }

    /// Lock this account into post-quantum-only mode AND register the Dilithium3
    /// public key that all future TXs from this account must use.
    ///
    /// One-way upgrade — calling on an already-locked account is a no-op (the
    /// existing registered key is preserved). Caller MUST verify the
    /// `SetPQRequirement` transaction was signed with both Ed25519 and Dilithium3
    /// (proving the account holder owns both keypairs) before invoking, and that
    /// the Dilithium3 public key on the TX is well-formed (3904 hex chars).
    ///
    /// `registered_dilithium_pk` is the hex-encoded ML-DSA-65 public key (3904
    /// chars / 1952 bytes). Stored verbatim and used for byte-equal comparison
    /// at every subsequent TX apply.
    pub fn lock_pq_signature_required(&mut self, registered_dilithium_pk: String) {
        if !self.require_pq_signature {
            // First time lock — register the key
            self.require_pq_signature = true;
            self.dilithium_public_key = Some(registered_dilithium_pk);
        }
        // If already locked, dilithium_public_key is preserved (no rebinding).
    }

    /// Get the registered Dilithium3 public key for this account, if any.
    /// `None` for accounts that haven't opted into PQ enforcement.
    pub fn registered_dilithium_pk(&self) -> Option<&str> {
        self.dilithium_public_key.as_deref()
    }
}

