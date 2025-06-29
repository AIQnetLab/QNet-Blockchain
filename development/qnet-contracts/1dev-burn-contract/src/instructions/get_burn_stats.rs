use anchor_lang::prelude::*;
use crate::state::*;

#[derive(Accounts)]
pub struct GetBurnStats<'info> {
    #[account(
        seeds = [b"burn_tracker"],
        bump = burn_tracker.bump
    )]
    pub burn_tracker: Account<'info, BurnTracker>,
}

pub fn handler(ctx: Context<GetBurnStats>) -> Result<BurnStats> {
    let burn_tracker = &ctx.accounts.burn_tracker;
    let clock = Clock::get()?;
    
    // Calculate burn percentage
    let burn_percentage = (burn_tracker.total_burned as f64 / ONEDEV_TOTAL_SUPPLY as f64) * 100.0;
    
    // Calculate days since launch
    let seconds_since_launch = clock.unix_timestamp - burn_tracker.launch_timestamp;
    let days_since_launch = (seconds_since_launch / 86400) as u64;
    
    Ok(BurnStats {
        total_burned: burn_tracker.total_burned,
        burn_percentage,
        days_since_launch,
        total_transactions: burn_tracker.total_transactions,
    })
} 