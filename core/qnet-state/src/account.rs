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
    // PURE DILITHIUM (F0.1): per-account `require_pq_signature` + `dilithium_public_key`
    // removed — PQ signing is mandatory network-wide and the address IS the key binding,
    // so a per-wallet opt-in flag + registered-key field are obsolete.

    // ═══════════════════════════════════════════════════════════════════════════
    // v34: UNFORGEABLE LIVENESS COUNTER (replaces self-attested HeartbeatCommitment)
    // ═══════════════════════════════════════════════════════════════════════════
    // The 14400-block epoch is split into 10 subwindows (1440 blocks each). Each valid
    // on-chain Heartbeat TX from this node sets the bit of its subwindow. Reward
    // eligibility = popcount(heartbeat_slots) >= 9 — but now UNFORGEABLE (the count is
    // built from on-chain heartbeat TXs that cannot be backfilled, not a self-declared
    // commitment). These fields are part of the state_root leaf hash (fixed schema,
    // unconditional — see hash_account) so reward eligibility is consensus-bound.
    /// Epoch (= anchor_height/14400) the current `heartbeat_slots` bitmask belongs to.
    #[serde(default)]
    pub heartbeat_epoch: u64,
    /// Subwindow bitmask for `heartbeat_epoch`: bit i set ⇒ ≥1 valid heartbeat in subwindow i.
    #[serde(default)]
    pub heartbeat_slots: u16,
    /// The most recently FINALIZED epoch (set on rollover) — lets the epoch-boundary reward
    /// snapshot read the just-completed epoch's count even after the node rolled to the next.
    #[serde(default)]
    pub heartbeat_final_epoch: u64,
    /// Subwindow bitmask for `heartbeat_final_epoch`. A BITMASK, not a count: a heartbeat that lands
    /// after the epoch rolled (admission allows up to HB_ANCHOR_MAX_LAG blocks of anchor lag) folds in
    /// idempotently, so eligibility cannot depend on inclusion order inside the admission window.
    #[serde(default)]
    pub heartbeat_final_slots: u16,

    /// Highest reward epoch this account has already claimed (merkle-claim anti-replay).
    /// A claim TX is valid only for an epoch strictly greater than this and advances it on
    /// success. Part of the leaf hash (consensus-bound — see hash_account).
    #[serde(default)]
    pub last_claimed_epoch: u64,

    // ═══════════════════════════════════════════════════════════════════════════
    // V2: PER-CONTRACT STORAGE MERKLE ROOT
    // ═══════════════════════════════════════════════════════════════════════════
    /// Root of this contract's StorageMerkleTree over the ENTIRE contract_storage map (one leaf per
    /// key). For contract accounts it is committed into the account leaf (hash_account SROOT branch),
    /// giving each stored value — token balances, total_supply, allowances — an individual merkle proof.
    /// For non-contract accounts it is inert (never hashed). Kept in lockstep with contract_storage by a
    /// pure post-apply recompute, so it can never drift. Appended LAST to keep bincode positional layout.
    #[serde(default)]
    pub storage_root: [u8; 32],

    /// FIX-5 (pk-elision): the account holder's RAW ML-DSA-65 public key (1952 B), bound ONCE at
    /// the account's first on-chain transaction and immutable thereafter. Lets later transactions
    /// ELIDE the 1952-byte key from the wire and still verify against this stored one. Folded into
    /// hash_account (state_root) so a snapshot cannot serve a wrong verify-key without failing state
    /// verification. `from == format_eon(SHA512(pk))` makes the binding self-consistent. None until
    /// the account has sent its first tx (receive-only wallets never populate it). Appended LAST to
    /// keep the bincode positional layout of the pre-FIX-5 fields.
    #[serde(default)]
    pub dilithium_public_key: Option<Vec<u8>>,

    /// Height at which a verified equivocation proof banned this identity; 0 = not banned. Write-once
    /// and permanent, matching the consensus ban. Lives HERE, in state the snapshot already proves,
    /// because the reward decision happens at a settle height that cannot reach back to the macroblock
    /// where the ban was certified — every attempt to bridge those two points was either
    /// non-deterministic across node classes or unhealable once broken.
    #[serde(default)]
    pub banned_at_height: u64,
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
            is_contract: false,
            contract_code_hash: None,
            contract_storage: HashMap::new(),
            heartbeat_epoch: 0,
            heartbeat_slots: 0,
            heartbeat_final_epoch: 0,
            heartbeat_final_slots: 0,
            last_claimed_epoch: 0,
            banned_at_height: 0,
            storage_root: *crate::state::EMPTY_STORAGE_ROOT,
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
    /// True iff this account is a QRC-20 token contract (contract_storage["type"] == "qrc20").
    /// The ONE named predicate for the token-type gate — apply-path dispatch, the owns index, and the
    /// RPC token readers all mean the same thing by "is a QRC-20", so it lives in one place.
    #[inline]
    pub fn is_qrc20(&self) -> bool {
        self.contract_storage.get("type").map(|t| t == "qrc20").unwrap_or(false)
    }

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
            is_contract: false,
            contract_code_hash: None,
            contract_storage: HashMap::new(),
            heartbeat_epoch: 0,
            heartbeat_slots: 0,
            heartbeat_final_epoch: 0,
            heartbeat_final_slots: 0,
            last_claimed_epoch: 0,
            banned_at_height: 0,
            storage_root: *crate::state::EMPTY_STORAGE_ROOT,
            dilithium_public_key: None, // FIX-5: bound at first-use apply, not construction
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
            is_contract: false,
            contract_code_hash: None,
            contract_storage: HashMap::new(),
            heartbeat_epoch: 0,
            heartbeat_slots: 0,
            heartbeat_final_epoch: 0,
            heartbeat_final_slots: 0,
            last_claimed_epoch: 0,
            banned_at_height: 0,
            storage_root: *crate::state::EMPTY_STORAGE_ROOT,
            dilithium_public_key: None, // FIX-5: bound at first-use apply, not construction
        }
    }

    /// Update metadata timestamp
    pub fn touch(&mut self, timestamp: u64) {
        if self.created_at == 0 {
            self.created_at = timestamp;
        }
        self.updated_at = timestamp;
    }

}

