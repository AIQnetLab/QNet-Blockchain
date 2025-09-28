use anchor_lang::prelude::*;

/// Node types for activation (Phase 1: using 1DEV, Phase 2: using QNC)
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum NodeType {
    Light,
    Full,
    Super,
}

impl NodeType {
    /// Get 1DEV burn amount for Phase 1 activation (decreasing by 150 1DEV per 10% burned)
    pub fn get_1dev_burn_amount(&self, burn_percentage: f64) -> u64 {
        let base_amount = 1_500_000_000; // 1500 1DEV for ALL node types (6 decimals)
        let min_amount = 150_000_000;    // 150 1DEV minimum (6 decimals)
        
        // CORRECT dynamic pricing: decreases by 150 1DEV per 10% burned
        let completed_tiers = (burn_percentage / 10.0).floor();
        let total_reduction = completed_tiers * PRICE_REDUCTION_PER_TIER as f64;
        let current_price = (base_amount as f64 - total_reduction).max(min_amount as f64);
        
        current_price as u64
    }

    /// Get QNC amount for Phase 2 activation (after 90% 1DEV burned or 5 years)
    pub fn get_qnc_activation_amount(&self) -> u64 {
        match self {
            NodeType::Light => 5_000_000_000,   // 5000 QNC
            NodeType::Full => 7_500_000_000,    // 7500 QNC
            NodeType::Super => 10_000_000_000,  // 10000 QNC
        }
    }
}

/// Main 1DEV burn tracker state
#[account]
pub struct BurnTracker {
    /// Authority who can update the tracker
    pub authority: Pubkey,
    /// Admin who can pause/unpause
    pub admin: Pubkey,
    /// Burn address (Solana incinerator)
    pub burn_address: Pubkey,
    /// 1DEV mint address
    pub one_dev_mint: Pubkey,
    /// Network genesis timestamp (first block time)
    pub genesis_timestamp: i64,
    /// Total 1DEV burned (in smallest units - 6 decimals)
    pub total_1dev_burned: u64,
    /// Total burn transactions recorded
    pub total_burn_transactions: u64,
    /// Total nodes activated
    pub total_nodes_activated: u64,
    /// Light nodes activated
    pub light_nodes: u64,
    /// Full nodes activated
    pub full_nodes: u64,
    /// Super nodes activated
    pub super_nodes: u64,
    /// Current burn percentage of 1DEV supply
    pub burn_percentage: f64,
    /// Phase transition executed (to QNC phase)
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
        32 + // one_dev_mint
        8 +  // genesis_timestamp
        8 +  // total_1dev_burned
        8 +  // total_burn_transactions
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
        
        // Transition at 90% 1DEV burned OR 5 years elapsed since QNet NETWORK GENESIS BLOCK
        // (fixed genesis timestamp, not contract deployment time)
        self.burn_percentage >= 90.0 || days_elapsed >= 1825 // 5 years = 1825 days
    }

    pub fn update_burn_percentage(&mut self) {
        self.burn_percentage = (self.total_1dev_burned as f64 / ONE_DEV_TOTAL_SUPPLY as f64) * 100.0;
    }

    pub fn get_current_1dev_price(&self) -> u64 {
        // All node types cost the same in Phase 1 - just 1DEV amount varies by burn %
        NodeType::Light.get_1dev_burn_amount(self.burn_percentage)
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
    /// 1DEV amount burned for activation (Phase 1)
    pub one_dev_burned: u64,
    /// QNC amount used for activation (Phase 2)
    pub qnc_used: u64,
    /// Activation phase (1 = 1DEV burn, 2 = QNC stake)
    pub activation_phase: u8,
    /// Activation signature for verification
    pub activation_signature: [u8; 64],
    /// Is active (not slashed)
    pub is_active: bool,
    /// Total QNC rewards claimed
    pub qnc_rewards_claimed: u64,
    /// Bump seed
    pub bump: u8,
}

impl NodeActivationRecord {
    pub const LEN: usize = 8 + // discriminator
        32 + // node_pubkey
        1 +  // node_type
        8 +  // activated_at
        8 +  // one_dev_burned
        8 +  // qnc_used
        1 +  // activation_phase
        64 + // activation_signature
        1 +  // is_active
        8 +  // qnc_rewards_claimed
        1;   // bump
}

/// 1DEV burn record for audit trail
#[account]
pub struct BurnRecord {
    /// Solana transaction signature
    pub solana_tx_signature: String,
    /// 1DEV amount burned
    pub one_dev_amount: u64,
    /// Burner's Solana wallet address
    pub burner_wallet: Pubkey,
    /// QNet node activated (if applicable)
    pub qnet_node_activated: Option<Pubkey>,
    /// Burn timestamp
    pub burn_timestamp: i64,
    /// Solana block height
    pub solana_block_height: u64,
    /// Burn verification status
    pub verified: bool,
    /// Bump seed
    pub bump: u8,
}

impl BurnRecord {
    pub const LEN: usize = 8 + // discriminator
        88 + // solana_tx_signature (max 88 chars)
        8 +  // one_dev_amount
        32 + // burner_wallet
        33 + // qnet_node_activated (Option<Pubkey>)
        8 +  // burn_timestamp
        8 +  // solana_block_height
        1 +  // verified
        1;   // bump
}

/// Comprehensive burn statistics
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct BurnStatistics {
    /// Total 1DEV burned amount
    pub total_1dev_burned: u64,
    /// Burn percentage of 1DEV total supply
    pub burn_percentage: f64,
    /// Days since network launch
    pub days_since_launch: u64,
    /// Total burn transactions
    pub total_burn_transactions: u64,
    /// Total nodes activated
    pub total_nodes_activated: u64,
    /// Node breakdown
    pub light_nodes: u64,
    pub full_nodes: u64,
    pub super_nodes: u64,
    /// Current 1DEV pricing for activation
    pub current_1dev_price: u64,
    /// Phase transition status
    pub phase_transitioned: bool,
    pub should_transition: bool,
    /// Phase 2 QNC activation costs
    pub qnc_light_cost: u64,
    pub qnc_full_cost: u64,
    pub qnc_super_cost: u64,
    /// Contract health
    pub is_paused: bool,
    pub last_update: i64,
}

// REMOVED UNUSED STRUCTURES:  
// - PhaseTransitionRecord (not used in contract)
// - QNCRewardClaimRecord (not used in contract)
// - TransitionTrigger enum (not used in contract)  
// - RewardPoolSource enum (not used in contract)

/// Constants for 1DEV token
pub const ONE_DEV_TOTAL_SUPPLY: u64 = 1_000_000_000_000_000; // 1 billion with 6 decimals
pub const ONE_DEV_DECIMALS: u8 = 6;
pub const BURN_TARGET_PERCENT: f64 = 90.0;
pub const MAX_TRANSITION_DAYS: u64 = 1825; // 5 years
pub const SECONDS_PER_DAY: i64 = 86400;

// 1DEV pricing constants (Phase 1)
pub const BASE_1DEV_PRICE: u64 = 1_500_000_000;   // 1500 1DEV base
pub const MIN_1DEV_PRICE: u64 = 150_000_000;      // 150 1DEV minimum
pub const PRICE_REDUCTION_PER_TIER: u64 = 150_000_000; // 150 1DEV reduction per 10% tier

// QNC activation costs (Phase 2) - 9 decimals
pub const QNC_LIGHT_ACTIVATION: u64 = 5_000_000_000_000;   // 5000 QNC (in nanoQNC)
pub const QNC_FULL_ACTIVATION: u64 = 7_500_000_000_000;    // 7500 QNC (in nanoQNC)
pub const QNC_SUPER_ACTIVATION: u64 = 10_000_000_000_000;  // 10000 QNC (in nanoQNC)

/// Seeds for PDA derivation
pub const BURN_TRACKER_SEED: &[u8] = b"burn_tracker";
pub const NODE_ACTIVATION_SEED: &[u8] = b"node_activation";
pub const BURN_RECORD_SEED: &[u8] = b"burn_record";
// REMOVED UNUSED SEEDS:
// pub const PHASE_TRANSITION_SEED: &[u8] = b"phase_transition";
// pub const QNC_REWARD_CLAIM_SEED: &[u8] = b"qnc_reward_claim";

/// Error codes
pub const ERROR_INSUFFICIENT_1DEV: u32 = 6000;
pub const ERROR_CONTRACT_PAUSED: u32 = 6001;
pub const ERROR_PHASE_TRANSITIONED: u32 = 6002;
pub const ERROR_NODE_ALREADY_ACTIVATED: u32 = 6003;
pub const ERROR_INVALID_SIGNATURE: u32 = 6004;
pub const ERROR_UNAUTHORIZED: u32 = 6005;
pub const ERROR_BURN_NOT_VERIFIED: u32 = 6006;
pub const ERROR_WRONG_PHASE: u32 = 6007;
pub const ERROR_TRANSITION_NOT_READY: u32 = 6008; 