use anchor_lang::prelude::*;

/// Node types for activation
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum NodeType {
    Light,
    Full,
    Super,
}

impl NodeType {
    pub fn get_burn_amount(&self, burn_percentage: f64) -> u64 {
        // CORRECT Phase 1: Universal pricing - ALL node types cost the same
        let base_amount = 1_500_000_000; // 1500 1DEV for ALL node types
        
        // Dynamic pricing: decreases as burn percentage rises
        // Every 10% burned = -150 1DEV (10% reduction)
        let reduction_per_10_percent = 150_000_000; // 150 1DEV in units
        let reduction_tiers = (burn_percentage / 10.0).floor() as u64;
        let total_reduction = reduction_tiers * reduction_per_10_percent;
        
        // Minimum floor: 150 1DEV
        let minimum_amount = 150_000_000; // 150 1DEV
        
        // Calculate final amount
        let final_amount = base_amount.saturating_sub(total_reduction);
        final_amount.max(minimum_amount)
    }
}

/// Main burn tracker state
#[account]
pub struct BurnTracker {
    /// Authority who can update the tracker
    pub authority: Pubkey,
    /// Admin who can pause/unpause
    pub admin: Pubkey,
    /// Burn address (dead address)
    pub burn_address: Pubkey,
    /// Network genesis timestamp (first block time)
    pub genesis_timestamp: i64,
    /// Total 1DEV burned (in smallest units)
    pub total_burned: u64,
    /// Total burn transactions recorded
    pub total_transactions: u64,
    /// Total nodes activated
    pub total_nodes_activated: u64,
    /// Light nodes activated
    pub light_nodes: u64,
    /// Full nodes activated
    pub full_nodes: u64,
    /// Super nodes activated
    pub super_nodes: u64,
    /// Current burn percentage
    pub burn_percentage: f64,
    /// Phase transition executed
    pub phase_transitioned: bool,
    /// Emergency pause state
    pub paused: bool,
    /// Last update timestamp
    pub last_update: i64,
    /// Bump seed
    pub bump: u8,
}

impl BurnTracker {
    pub const LEN: usize = 8 + // discriminator
        32 + // authority
        32 + // admin
        32 + // burn_address
        8 +  // genesis_timestamp
        8 +  // total_burned
        8 +  // total_transactions
        8 +  // total_nodes_activated
        8 +  // light_nodes
        8 +  // full_nodes
        8 +  // super_nodes
        8 +  // burn_percentage
        1 +  // phase_transitioned
        1 +  // paused
        8 +  // last_update
        1;   // bump

    pub fn should_transition(&self) -> bool {
        let current_time = Clock::get().unwrap().unix_timestamp;
        let days_elapsed = (current_time - self.genesis_timestamp) / 86400;
        
        self.burn_percentage >= 90.0 || days_elapsed >= 1825 // 5 years
    }

    pub fn update_burn_percentage(&mut self) {
        self.burn_percentage = (self.total_burned as f64 / ONE_DEV_TOTAL_SUPPLY as f64) * 100.0;
    }
}

/// Node activation record
#[account]
pub struct NodeActivationRecord {
    /// Node public key
    pub node_pubkey: Pubkey,
    /// Node type
    pub node_type: NodeType,
    /// Activation timestamp
    pub activated_at: i64,
    /// 1DEV amount burned for activation
    pub burn_amount: u64,
    /// Activation signature for verification
    pub activation_signature: [u8; 64],
    /// Is active (not slashed)
    pub is_active: bool,
    /// Total rewards claimed
    pub rewards_claimed: u64,
    /// Bump seed
    pub bump: u8,
}

impl NodeActivationRecord {
    pub const LEN: usize = 8 + // discriminator
        32 + // node_pubkey
        1 +  // node_type
        8 +  // activated_at
        8 +  // burn_amount
        64 + // activation_signature
        1 +  // is_active
        8 +  // rewards_claimed
        1;   // bump
}

/// Burn record for audit trail
#[account]
pub struct BurnRecord {
    /// Transaction signature
    pub tx_signature: String,
    /// Amount burned
    pub amount: u64,
    /// Burner's address
    pub burner: Pubkey,
    /// Node activated (if applicable)
    pub node_activated: Option<Pubkey>,
    /// Timestamp
    pub timestamp: i64,
    /// Burn block height
    pub block_height: u64,
    /// Bump seed
    pub bump: u8,
}

impl BurnRecord {
    pub const LEN: usize = 8 + // discriminator
        64 + // tx_signature (max 64 chars)
        8 +  // amount
        32 + // burner
        33 + // node_activated (Option<Pubkey>)
        8 +  // timestamp
        8 +  // block_height
        1;   // bump
}

/// Comprehensive burn statistics
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct BurnStatistics {
    /// Total burned amount
    pub total_burned: u64,
    /// Burn percentage of total supply
    pub burn_percentage: f64,
    /// Days since network launch
    pub days_since_launch: u64,
    /// Total burn transactions
    pub total_transactions: u64,
    /// Total nodes activated
    pub total_nodes_activated: u64,
    /// Node breakdown
    pub light_nodes: u64,
    pub full_nodes: u64,
    pub super_nodes: u64,
    /// Current pricing
    pub current_light_price: u64,
    pub current_full_price: u64,
    pub current_super_price: u64,
    /// Phase transition status
    pub phase_transitioned: bool,
    pub should_transition: bool,
    /// Contract health
    pub is_paused: bool,
    pub last_update: i64,
}

/// Phase transition record
#[account]
pub struct PhaseTransitionRecord {
    /// Transition timestamp
    pub transition_timestamp: i64,
    /// Final burn amount
    pub final_burn_amount: u64,
    /// Final burn percentage
    pub final_burn_percentage: f64,
    /// Total nodes at transition
    pub nodes_at_transition: u64,
    /// Transition trigger (burn percentage or time limit)
    pub trigger_reason: TransitionTrigger,
    /// Bump seed
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum TransitionTrigger {
    BurnPercentage, // 90% burned
    TimeLimit,      // 5 years elapsed
}

impl PhaseTransitionRecord {
    pub const LEN: usize = 8 + // discriminator
        8 +  // transition_timestamp
        8 +  // final_burn_amount
        8 +  // final_burn_percentage
        8 +  // nodes_at_transition
        1 +  // trigger_reason
        1;   // bump
}

/// Reward claim record
#[account]
pub struct RewardClaimRecord {
    /// Node public key
    pub node_pubkey: Pubkey,
    /// Claim timestamp
    pub claim_timestamp: i64,
    /// Reward amount
    pub reward_amount: u64,
    /// Claim period (epoch)
    pub claim_epoch: u64,
    /// Bump seed
    pub bump: u8,
}

impl RewardClaimRecord {
    pub const LEN: usize = 8 + // discriminator
        32 + // node_pubkey
        8 +  // claim_timestamp
        8 +  // reward_amount
        8 +  // claim_epoch
        1;   // bump
}

/// Constants for 1DEV token
pub const ONE_DEV_TOTAL_SUPPLY: u64 = 1_000_000_000_000_000; // 1 billion with 6 decimals
pub const ONE_DEV_DECIMALS: u8 = 6;
pub const BURN_TARGET_PERCENT: f64 = 90.0;
pub const MAX_TRANSITION_DAYS: u64 = 1825; // 5 years
pub const SECONDS_PER_DAY: i64 = 86400;

// 1DEV pricing constants (Phase 1)
pub const BASE_1DEV_PRICE: u64 = 1_500_000_000;   // 1500 1DEV base
pub const MIN_1DEV_PRICE: u64 = 150_000_000;      // 150 1DEV minimum
pub const PRICE_REDUCTION_PER_10_PERCENT: f64 = 0.1; // 10% reduction per 10% burned

// QNC activation costs (Phase 2)
pub const QNC_LIGHT_ACTIVATION: u64 = 5_000_000_000;   // 5000 QNC
pub const QNC_FULL_ACTIVATION: u64 = 7_500_000_000;    // 7500 QNC  
pub const QNC_SUPER_ACTIVATION: u64 = 10_000_000_000;  // 10000 QNC

/// Seeds for PDA derivation
pub const BURN_TRACKER_SEED: &[u8] = b"burn_tracker";
pub const NODE_ACTIVATION_SEED: &[u8] = b"node_activation";
pub const BURN_RECORD_SEED: &[u8] = b"burn_record";
pub const PHASE_TRANSITION_SEED: &[u8] = b"phase_transition";
pub const QNC_REWARD_CLAIM_SEED: &[u8] = b"qnc_reward_claim";

/// Error codes
pub const ERROR_INSUFFICIENT_1DEV: u32 = 6000;
pub const ERROR_CONTRACT_PAUSED: u32 = 6001;
pub const ERROR_PHASE_TRANSITIONED: u32 = 6002;
pub const ERROR_NODE_ALREADY_ACTIVATED: u32 = 6003;
pub const ERROR_INVALID_SIGNATURE: u32 = 6004;
pub const ERROR_UNAUTHORIZED: u32 = 6005;
pub const ERROR_BURN_NOT_VERIFIED: u32 = 6006;
pub const ERROR_WRONG_PHASE: u32 = 6007; 