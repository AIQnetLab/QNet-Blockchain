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

pub fn handler(ctx: Context<GetBurnStats>) -> Result<BurnStatistics> {
    let burn_tracker = &ctx.accounts.burn_tracker;
    let clock = Clock::get()?;
    
    // Calculate burn percentage
    let burn_percentage = (burn_tracker.total_1dev_burned as f64 / ONE_DEV_TOTAL_SUPPLY as f64) * 100.0;
    
    // Calculate days since launch
    let seconds_since_genesis = clock.unix_timestamp - burn_tracker.genesis_timestamp;
    let days_since_genesis = (seconds_since_genesis / SECONDS_PER_DAY) as u64;
    
    Ok(BurnStatistics {
        total_1dev_burned: burn_tracker.total_1dev_burned,
        burn_percentage,
        days_since_launch: days_since_genesis,
        total_burn_transactions: burn_tracker.total_burn_transactions,
        total_nodes_activated: burn_tracker.total_nodes_activated,
        light_nodes: burn_tracker.light_nodes,
        full_nodes: burn_tracker.full_nodes,
        super_nodes: burn_tracker.super_nodes,
        current_1dev_price: burn_tracker.get_current_1dev_price(),
        phase_transitioned: burn_tracker.phase_transitioned,
        should_transition: burn_tracker.should_transition(),
        qnc_light_cost: QNC_LIGHT_ACTIVATION,
        qnc_full_cost: QNC_FULL_ACTIVATION,
        qnc_super_cost: QNC_SUPER_ACTIVATION,
        is_paused: burn_tracker.paused,
        last_update: burn_tracker.last_update,
    })
} 