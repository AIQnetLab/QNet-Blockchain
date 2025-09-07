use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::*;

#[derive(Accounts)]
#[instruction(amount: u64, tx_signature: String)]
pub struct RecordBurn<'info> {
    #[account(
        mut,
        seeds = [b"burn_tracker"],
        bump = burn_tracker.bump
    )]
    pub burn_tracker: Account<'info, BurnTracker>,
    
    #[account(
        init,
        payer = burner,
        space = BurnRecord::LEN,
        seeds = [b"burn_record", tx_signature.as_bytes()],
        bump
    )]
    pub burn_record: Account<'info, BurnRecord>,
    
    #[account(mut)]
    pub burner: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<RecordBurn>,
    amount: u64,
    tx_signature: String,
) -> Result<()> {
    let burn_tracker = &mut ctx.accounts.burn_tracker;
    let burn_record = &mut ctx.accounts.burn_record;
    let clock = Clock::get()?;
    
    // Validate amount
    require!(amount > 0, BurnError::InvalidAmount);
    
    // Update burn tracker
    burn_tracker.total_1dev_burned = burn_tracker.total_1dev_burned
        .checked_add(amount)
        .ok_or(BurnError::Overflow)?;
    burn_tracker.total_burn_transactions += 1;
    
    // Update burn_percentage in burn_tracker
    burn_tracker.update_burn_percentage();
    burn_tracker.last_update = clock.unix_timestamp;
    
    // Create burn record
    burn_record.solana_tx_signature = tx_signature;
    burn_record.one_dev_amount = amount;
    burn_record.burner_wallet = ctx.accounts.burner.key();
    burn_record.qnet_node_activated = None;
    burn_record.burn_timestamp = clock.unix_timestamp;
    burn_record.solana_block_height = clock.slot;
    burn_record.verified = true;
    burn_record.bump = ctx.bumps.burn_record;
    
    msg!("Burn recorded successfully");
    msg!("Amount: {} 1DEV", amount);
    msg!("Total burned: {} 1DEV", burn_tracker.total_1dev_burned);
    msg!("Burn percentage: {:.2}%", burn_tracker.burn_percentage);
    
    Ok(())
} 