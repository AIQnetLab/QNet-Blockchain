use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::BurnError;

#[derive(Accounts)]
pub struct ExecutePhaseTransition<'info> {
    #[account(
        mut,
        seeds = [BURN_TRACKER_SEED],
        bump = burn_tracker.bump,
        constraint = !burn_tracker.phase_transitioned @ BurnError::PhaseTransitioned
    )]
    pub burn_tracker: Account<'info, BurnTracker>,
    
    /// Anyone can call this function when transition conditions are met
    pub caller: Signer<'info>,
}

pub fn handler(ctx: Context<ExecutePhaseTransition>) -> Result<()> {
    let burn_tracker = &mut ctx.accounts.burn_tracker;
    let clock = Clock::get()?;
    
    // Check transition conditions: 90% burned OR 5 years elapsed since genesis
    require!(
        burn_tracker.should_transition(),
        BurnError::TransitionNotReady
    );
    
    // Execute Phase 2 transition
    burn_tracker.phase_transitioned = true;
    burn_tracker.last_update = clock.unix_timestamp;
    
    msg!("🚀 PHASE 2 TRANSITION EXECUTED!");
    msg!("✅ 1DEV burn activation is now PERMANENTLY DISABLED");
    msg!("✅ QNC Pool #3 activation system is now ACTIVE");
    msg!("📊 Final burn percentage: {:.2}%", burn_tracker.burn_percentage);
    msg!("📊 Total 1DEV burned: {} tokens", burn_tracker.total_1dev_burned);
    msg!("📊 Total nodes activated in Phase 1: {}", burn_tracker.total_nodes_activated);
    
    // Calculate days elapsed for logging
    let days_elapsed = (clock.unix_timestamp - burn_tracker.genesis_timestamp) / 86400;
    msg!("⏱️ Days since genesis: {}", days_elapsed);
    
    if burn_tracker.burn_percentage >= 90.0 {
        msg!("🔥 Transition triggered by: 90% burn threshold reached");
    } else {
        msg!("⏰ Transition triggered by: 5-year time limit reached");
    }
    
    Ok(())
} 