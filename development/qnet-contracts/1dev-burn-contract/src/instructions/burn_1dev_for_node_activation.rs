use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token};
use crate::state::*;
use crate::errors::BurnError;

#[derive(Accounts)]
#[instruction(node_type: NodeType, one_dev_amount: u64, solana_burn_tx: String)]
pub struct Burn1DevForNodeActivation<'info> {
    #[account(
        mut,
        seeds = [BURN_TRACKER_SEED],
        bump = burn_tracker.bump,
        constraint = !burn_tracker.paused @ BurnError::ContractPaused,
        constraint = !burn_tracker.phase_transitioned @ BurnError::PhaseTransitioned
    )]
    pub burn_tracker: Account<'info, BurnTracker>,

    #[account(
        init,
        payer = user,
        space = NodeActivationRecord::LEN,
        seeds = [NODE_ACTIVATION_SEED, node_pubkey.key().as_ref()],
        bump
    )]
    pub node_activation: Account<'info, NodeActivationRecord>,

    #[account(
        init,
        payer = user,
        space = BurnRecord::LEN,
        seeds = [BURN_RECORD_SEED, solana_burn_tx.as_bytes()],
        bump
    )]
    pub burn_record: Account<'info, BurnRecord>,

    /// User's Solana wallet that burned 1DEV tokens
    #[account(mut)]
    pub user: Signer<'info>,

    /// QNet node public key to be activated
    /// CHECK: This is the node's public key for QNet activation
    pub node_pubkey: AccountInfo<'info>,

    /// 1DEV token mint (Solana SPL)
    #[account(
        address = burn_tracker.one_dev_mint @ BurnError::InvalidMint
    )]
    pub one_dev_mint: Account<'info, Mint>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<Burn1DevForNodeActivation>,
    node_type: NodeType,
    one_dev_amount: u64,
    solana_burn_tx: String,
    _node_pubkey: Pubkey,
) -> Result<()> {
    let burn_tracker = &mut ctx.accounts.burn_tracker;
    let node_activation = &mut ctx.accounts.node_activation;
    let burn_record = &mut ctx.accounts.burn_record;
    let clock = Clock::get()?;

    // Validate burn transaction signature format
    require!(
        solana_burn_tx.len() >= 64 && solana_burn_tx.len() <= 88,
        BurnError::InvalidBurnTransaction
    );

    // Calculate required 1DEV amount based on current burn percentage
    let required_amount = node_type.get_1dev_burn_amount(burn_tracker.burn_percentage);
    
    // Validate burn amount
    require!(
        one_dev_amount >= required_amount,
        BurnError::InsufficientBurnAmount
    );

    // SECURITY: Check for duplicate burn transaction
    // This prevents reusing the same burn transaction for multiple activations
    require!(
        burn_record.to_account_info().lamports() == 0, // Account must be new
        BurnError::DuplicateBurnTransaction
    );

    // Verify burn transaction on Solana (simplified for production)
    // In production, this would verify the burn transaction on Solana chain
    let verified_burn = verify_solana_burn_transaction(
        &solana_burn_tx,
        &ctx.accounts.user.key(),
        one_dev_amount,
        &burn_tracker.burn_address,
        &burn_tracker.one_dev_mint,
    )?;

    require!(verified_burn, BurnError::BurnNotVerified);

    // Create activation signature for QNet verification
    let activation_signature = generate_activation_signature(
        &ctx.accounts.node_pubkey.key(),
        &ctx.accounts.user.key(),
        &solana_burn_tx,
        node_type.clone(),
        one_dev_amount,
    )?;

    // Initialize node activation record
    node_activation.node_pubkey = ctx.accounts.node_pubkey.key();
    node_activation.node_type = node_type.clone();
    node_activation.activated_at = clock.unix_timestamp;
    node_activation.one_dev_burned = one_dev_amount;
    node_activation.qnc_used = 0; // Phase 1 uses 1DEV burn
    node_activation.activation_phase = 1;
    node_activation.activation_signature = activation_signature;
    node_activation.is_active = true;
    node_activation.qnc_rewards_claimed = 0;
    node_activation.bump = ctx.bumps.node_activation;

    // Initialize burn record for audit trail
    burn_record.solana_tx_signature = solana_burn_tx.clone();
    burn_record.one_dev_amount = one_dev_amount;
    burn_record.burner_wallet = ctx.accounts.user.key();
    burn_record.qnet_node_activated = Some(ctx.accounts.node_pubkey.key());
    burn_record.burn_timestamp = clock.unix_timestamp;
    burn_record.solana_block_height = clock.slot; // Approximate block height
    burn_record.verified = true;
    burn_record.bump = ctx.bumps.burn_record;

    // Update burn tracker statistics
    burn_tracker.total_1dev_burned = burn_tracker.total_1dev_burned
        .checked_add(one_dev_amount)
        .ok_or(BurnError::MathOverflow)?;
    
    burn_tracker.total_burn_transactions = burn_tracker.total_burn_transactions
        .checked_add(1)
        .ok_or(BurnError::MathOverflow)?;
    
    burn_tracker.total_nodes_activated = burn_tracker.total_nodes_activated
        .checked_add(1)
        .ok_or(BurnError::MathOverflow)?;

    // Update node type counters
    match node_type {
        NodeType::Light => {
            burn_tracker.light_nodes = burn_tracker.light_nodes
                .checked_add(1)
                .ok_or(BurnError::MathOverflow)?;
        }
        NodeType::Full => {
            burn_tracker.full_nodes = burn_tracker.full_nodes
                .checked_add(1)
                .ok_or(BurnError::MathOverflow)?;
        }
        NodeType::Super => {
            burn_tracker.super_nodes = burn_tracker.super_nodes
                .checked_add(1)
                .ok_or(BurnError::MathOverflow)?;
        }
    }

    // Update burn percentage
    burn_tracker.update_burn_percentage();
    burn_tracker.last_update = clock.unix_timestamp;

    // Emit activation event
    emit!(NodeActivatedEvent {
        node_pubkey: ctx.accounts.node_pubkey.key(),
        node_type: node_type,
        burn_amount: one_dev_amount,
        burn_tx: solana_burn_tx,
        activation_timestamp: clock.unix_timestamp,
        burn_percentage: burn_tracker.burn_percentage,
    });

    msg!("Node activated successfully: {} burn {} 1DEV", 
         ctx.accounts.node_pubkey.key(), 
         one_dev_amount
    );

    Ok(())
}

/// Verify burn transaction on Solana blockchain
/// In production, this would make cross-chain verification
fn verify_solana_burn_transaction(
    tx_signature: &str,
    burner: &Pubkey,
    amount: u64,
    burn_address: &Pubkey,
    mint: &Pubkey,
) -> Result<bool> {
    // Production implementation would:
    // 1. Query Solana RPC for transaction details
    // 2. Verify transaction signature validity
    // 3. Confirm tokens were sent to burn address
    // 4. Validate amount and sender
    // 5. Check transaction finality
    
    // For now, basic validation
    require!(
        tx_signature.len() >= 64,
        BurnError::InvalidBurnTransaction
    );
    
    require!(
        amount >= MIN_1DEV_PRICE,
        BurnError::InsufficientBurnAmount
    );

    // In production: actual cross-chain verification
    Ok(true)
}

/// Generate activation signature for QNet node verification
fn generate_activation_signature(
    node_pubkey: &Pubkey,
    burner: &Pubkey,
    burn_tx: &str,
    node_type: NodeType,
    amount: u64,
) -> Result<[u8; 64]> {
    // Create deterministic signature for node activation
    let message = format!(
        "QNET_ACTIVATION:{}:{}:{}:{}:{}",
        node_pubkey,
        burner,
        burn_tx,
        match node_type {
            NodeType::Light => "LIGHT",
            NodeType::Full => "FULL",
            NodeType::Super => "SUPER",
        },
        amount
    );

    // In production: proper cryptographic signature
    let mut signature = [0u8; 64];
    let hash = anchor_lang::solana_program::hash::hash(message.as_bytes());
    signature[..32].copy_from_slice(&hash.to_bytes());
    signature[32..].copy_from_slice(&hash.to_bytes());

    Ok(signature)
}

/// Node activation event
#[event]
pub struct NodeActivatedEvent {
    pub node_pubkey: Pubkey,
    pub node_type: NodeType,
    pub burn_amount: u64,
    pub burn_tx: String,
    pub activation_timestamp: i64,
    pub burn_percentage: f64,
}

// Error codes are defined in errors.rs 
