use anchor_lang::prelude::*;
use crate::state::*;

#[derive(Accounts)]
pub struct InitializeBurnTracker<'info> {
    #[account(
        init,
        payer = authority,
        space = BurnTracker::LEN,
        seeds = [b"burn_tracker"],
        bump
    )]
    pub burn_tracker: Account<'info, BurnTracker>,
    
    #[account(mut)]
    pub authority: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeBurnTracker>,
    authority: Pubkey,
    admin: Pubkey,
    burn_address: Pubkey,
    one_dev_mint: Pubkey,
    network_genesis_timestamp: i64,
) -> Result<()> {
    let burn_tracker = &mut ctx.accounts.burn_tracker;
    let clock = Clock::get()?;
    
    burn_tracker.authority = authority;
    burn_tracker.admin = admin;
    burn_tracker.burn_address = burn_address;
    burn_tracker.one_dev_mint = one_dev_mint;
    
    // Set genesis_timestamp as QNet network genesis block time (passed as parameter)
    // This is the REAL genesis block timestamp for 5-year Phase 2 limit calculation
    burn_tracker.genesis_timestamp = network_genesis_timestamp;
    
    burn_tracker.total_1dev_burned = 0;
    burn_tracker.total_burn_transactions = 0;
    burn_tracker.total_nodes_activated = 0;
    burn_tracker.light_nodes = 0;
    burn_tracker.full_nodes = 0;
    burn_tracker.super_nodes = 0;
    burn_tracker.burn_percentage = 0.0;
    burn_tracker.phase_transitioned = false;
    burn_tracker.paused = false;
    burn_tracker.last_update = clock.unix_timestamp;
    burn_tracker.bump = ctx.bumps.burn_tracker;
    
    msg!("Burn tracker initialized");
    msg!("Authority: {}", burn_tracker.authority);
    msg!("Burn address: {}", burn_tracker.burn_address);
    msg!("Genesis timestamp: {}", burn_tracker.genesis_timestamp);
    
    Ok(())
} 