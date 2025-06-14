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
    burn_tracker.total_burned = burn_tracker.total_burned
        .checked_add(amount)
        .ok_or(BurnError::Overflow)?;
    burn_tracker.total_transactions += 1;
    burn_tracker.last_update = clock.unix_timestamp;
    
    // Create burn record
    burn_record.tx_signature = tx_signature;
    burn_record.amount = amount;
    burn_record.burner = ctx.accounts.burner.key();
    burn_record.timestamp = clock.unix_timestamp;
    burn_record.bump = ctx.bumps.burn_record;
    
    // Calculate burn percentage
    let burn_percentage = (burn_tracker.total_burned as f64 / QNA_TOTAL_SUPPLY as f64) * 100.0;
    
    msg!("Burn recorded successfully");
    msg!("Amount: {} QNA", amount);
    msg!("Total burned: {} QNA", burn_tracker.total_burned);
    msg!("Burn percentage: {:.2}%", burn_percentage);
    
    Ok(())
} 