use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Mint, Transfer};

declare_id!("QNETxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");

pub mod state;
pub mod instructions;
pub mod errors;

use state::*;
use instructions::*;
use errors::*;

#[program]
pub mod one_dev_burn_contract {
    use super::*;

    /// Initialize the 1DEV burn tracker system
    pub fn initialize(
        ctx: Context<Initialize>,
        burn_address: Pubkey,
        one_dev_mint: Pubkey,
        admin: Pubkey,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, burn_address, one_dev_mint, admin)
    }

    /// Burn 1DEV tokens for QNet node activation access (Phase 1)
    pub fn burn_1dev_for_node_activation(
        ctx: Context<Burn1DevForNodeActivation>,
        node_type: NodeType,
        one_dev_amount: u64,
        solana_burn_tx: String,
    ) -> Result<()> {
        instructions::burn_1dev_for_node_activation::handler(ctx, node_type, one_dev_amount, solana_burn_tx)
    }

    /// Verify node activation status for any phase
    pub fn verify_node_activation(
        ctx: Context<VerifyNodeActivation>,
        node_pubkey: Pubkey,
    ) -> Result<NodeActivationRecord> {
        instructions::verify_node_activation::handler(ctx, node_pubkey)
    }

    /// Update burn pricing based on current 1DEV burn percentage
    pub fn update_burn_pricing(ctx: Context<UpdateBurnPricing>) -> Result<()> {
        instructions::update_burn_pricing::handler(ctx)
    }

    /// Get comprehensive burn and network statistics
    pub fn get_burn_statistics(ctx: Context<GetBurnStats>) -> Result<BurnStatistics> {
        instructions::get_burn_statistics::handler(ctx)
    }

    /// Emergency pause (admin only)
    pub fn emergency_pause(ctx: Context<EmergencyPause>, pause: bool) -> Result<()> {
        instructions::emergency_pause::handler(ctx, pause)
    }

    /// Activate node with QNC in Phase 2 (after 90% 1DEV burned or 5 years)
    pub fn activate_node_with_qnc(
        ctx: Context<ActivateNodeWithQNC>,
        node_type: NodeType,
        qnc_amount: u64,
    ) -> Result<()> {
        instructions::activate_node_with_qnc::handler(ctx, node_type, qnc_amount)
    }

    /// Claim QNC rewards for active nodes (Phase 2)
    pub fn claim_qnc_rewards(
        ctx: Context<ClaimQNCRewards>,
        pool_source: RewardPoolSource,
    ) -> Result<()> {
        instructions::claim_qnc_rewards::handler(ctx, pool_source)
    }

    /// Execute phase transition from 1DEV to QNC (automatic trigger)
    pub fn execute_phase_transition(ctx: Context<ExecutePhaseTransition>) -> Result<()> {
        instructions::execute_phase_transition::handler(ctx)
    }

    /// Verify Solana 1DEV burn transaction
    pub fn verify_solana_burn(
        ctx: Context<VerifySolanaBurn>,
        burn_tx_signature: String,
        expected_amount: u64,
        burner_wallet: Pubkey,
    ) -> Result<bool> {
        instructions::verify_solana_burn::handler(ctx, burn_tx_signature, expected_amount, burner_wallet)
    }

    /// Get current 1DEV pricing for node activation
    pub fn get_current_1dev_price(ctx: Context<GetCurrent1DevPrice>) -> Result<u64> {
        instructions::get_current_1dev_price::handler(ctx)
    }

    /// Bridge function: Grant QNet access after verified 1DEV burn
    pub fn grant_qnet_access(
        ctx: Context<GrantQNetAccess>,
        solana_wallet: Pubkey,
        qnet_node_pubkey: Pubkey,
        burn_verification_proof: [u8; 64],
    ) -> Result<()> {
        instructions::grant_qnet_access::handler(ctx, solana_wallet, qnet_node_pubkey, burn_verification_proof)
    }
} 