use anchor_lang::prelude::*;
use crate::state::*;

#[derive(Accounts)]
pub struct Initialize<'info> {
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
    ctx: Context<Initialize>,
    burn_address: Pubkey,
) -> Result<()> {
    let burn_tracker = &mut ctx.accounts.burn_tracker;
    let clock = Clock::get()?;
    
    burn_tracker.authority = ctx.accounts.authority.key();
    burn_tracker.burn_address = burn_address;
    burn_tracker.launch_timestamp = clock.unix_timestamp;
    burn_tracker.total_burned = 0;
    burn_tracker.total_transactions = 0;
    burn_tracker.last_update = clock.unix_timestamp;
    burn_tracker.bump = ctx.bumps.burn_tracker;
    
    msg!("Burn tracker initialized");
    msg!("Authority: {}", burn_tracker.authority);
    msg!("Burn address: {}", burn_tracker.burn_address);
    
    Ok(())
} 