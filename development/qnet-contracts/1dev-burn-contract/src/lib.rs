use anchor_lang::prelude::*;

// v14.5: Redeployed after security hardening (authority-attested burns,
// phase transition gated by verification_authority). New program keypair
// target/deploy/onedev_burn_contract-keypair.json.
declare_id!("CCZSessk1TbWie6Ye2JX2cNEWHTEWxCwe5sLz8JaFriw");

pub mod state;
pub mod errors;
pub mod instructions;

use instructions::*;
use state::*;

#[program]
pub mod onedev_burn_contract {
    use super::*;

    /// Initialize the 1DEV burn tracker
    pub fn initialize(
        ctx: Context<InitializeBurnTracker>,
        authority: Pubkey,
        admin: Pubkey,
        burn_address: Pubkey,
        one_dev_mint: Pubkey,
        network_genesis_timestamp: i64,
        verification_authority: Pubkey, // v14.5
    ) -> Result<()> {
        initialize::handler(
            ctx,
            authority,
            admin,
            burn_address,
            one_dev_mint,
            network_genesis_timestamp,
            verification_authority,
        )
    }

    /// Record a 1DEV burn transaction for node activation
    pub fn burn_1dev_for_node_activation(
        ctx: Context<Burn1DevForNodeActivation>,
        node_type: NodeType,
        one_dev_amount: u64,
        solana_burn_tx: String,
        _node_pubkey: Pubkey,
    ) -> Result<()> {
        burn_1dev_for_node_activation::handler(ctx, node_type, one_dev_amount, solana_burn_tx, _node_pubkey)
    }

    /// Record any 1DEV burn transaction
    pub fn record_burn(
        ctx: Context<RecordBurn>,
        tx_signature: String,
        one_dev_amount: u64,
    ) -> Result<()> {
        record_burn::handler(ctx, one_dev_amount, tx_signature)
    }

    /// Get current burn statistics
    pub fn get_burn_stats(ctx: Context<GetBurnStats>) -> Result<BurnStatistics> {
        get_burn_stats::handler(ctx)
    }

    /// Execute Phase 2 transition (disable 1DEV activation, enable QNC Pool #3)
    pub fn execute_phase_transition(ctx: Context<ExecutePhaseTransition>) -> Result<()> {
        execute_phase_transition::handler(ctx)
    }
} 