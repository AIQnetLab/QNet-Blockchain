use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::BurnError;

// ═══════════════════════════════════════════════════════════════════════════
// v14.5: PHASE TRANSITION NOW REQUIRES AUTHORITY SIGNER
// ═══════════════════════════════════════════════════════════════════════════
// Previous code allowed ANY signer to execute the transition once
// `should_transition()` returned true. Combined with the old `record_burn`
// (which accepted fake burns with `verified = true` unconditionally), an
// attacker could:
//   1. Call `record_burn` many times with synthetic tx signatures → inflate
//      `total_1dev_burned` past the 90% threshold.
//   2. Call `execute_phase_transition` themselves → flip `phase_transitioned`
//      to true PERMANENTLY (constraint `!phase_transitioned` prevents revert).
//   3. Phase 1 1DEV-burn activation is killed forever.
//
// v14.5 closes both holes in this file + `record_burn.rs` + `state.rs`:
//   - `record_burn` now requires the verification_authority signer, so fake
//     burns cannot inflate the counter anymore.
//   - `execute_phase_transition` now requires the same authority signer AND
//     keeps the organic trigger path (`should_transition()` still validated),
//     so the transition can fire when genuinely warranted but cannot be
//     weaponised by an unrelated caller.
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
pub struct ExecutePhaseTransition<'info> {
    #[account(
        mut,
        seeds = [BURN_TRACKER_SEED],
        bump = burn_tracker.bump,
        constraint = !burn_tracker.phase_transitioned @ BurnError::PhaseTransitioned
    )]
    pub burn_tracker: Account<'info, BurnTracker>,

    // v14.5: Authority signer (pinned via burn_tracker.verification_authority).
    // Only this account can finalise the phase transition.
    #[account(
        constraint = caller.key() == burn_tracker.verification_authority
            @ BurnError::UnauthorizedCaller
    )]
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