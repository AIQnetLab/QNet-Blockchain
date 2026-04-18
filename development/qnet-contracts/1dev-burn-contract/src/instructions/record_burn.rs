use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::*;

// ═══════════════════════════════════════════════════════════════════════════
// v14.5: BURN RECORD NOW REQUIRES PROOF-OF-BURN
// ═══════════════════════════════════════════════════════════════════════════
// Previous implementation accepted any `amount > 0` and set `verified = true`
// unconditionally. An attacker could call `record_burn` with an arbitrary
// synthetic transaction signature and a huge amount, inflating
// `total_1dev_burned`. Combined with `execute_phase_transition` (anyone-can-
// call once `should_transition()` returns true), that fake total could
// permanently flip the network into Phase 2 with no real burn.
//
// v14.5 changes:
//   1. `tx_signature` is validated as a real Solana signature (base58 →
//      64 bytes) — not just a non-empty string.
//   2. `amount` must meet `MIN_1DEV_PRICE` (same floor as activation path).
//   3. A `verification_authority` signer attests that the off-chain RPC
//      check of `tx_signature` against the official incinerator + mint
//      succeeded. The authority is pinned via `burn_tracker.verification_authority`
//      so only that account can write to `burn_record.verified = true`.
//   4. The burn record is bound to `burner.key()`, preventing a third party
//      from attributing someone else's burn to themselves.
//
// The verification authority pattern is standard for bridge-style flows
// where full tx verification is too expensive to do on-chain: the authority
// is typically a multisig / threshold signer operated by the protocol,
// bound at tracker initialization and rotatable via a separate admin
// instruction.
// ═══════════════════════════════════════════════════════════════════════════

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

    // v14.5: Authority that attests off-chain RPC verification of the burn.
    // Pinned via `burn_tracker.verification_authority`; must also sign.
    #[account(
        constraint = verification_authority.key() == burn_tracker.verification_authority
            @ BurnError::UnauthorizedCaller
    )]
    pub verification_authority: Signer<'info>,

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

    // v14.5: Amount floor matches activation path (no dust / token-spam).
    require!(amount >= MIN_1DEV_PRICE, BurnError::InsufficientBurnAmount);

    // v14.5: `tx_signature` must be a real Solana signature.
    // Prior code accepted any string; now we require 64-byte base58 decode.
    require!(
        tx_signature.len() >= 64 && tx_signature.len() <= 88,
        BurnError::InvalidBurnTransaction
    );
    let tx_bytes = bs58::decode(&tx_signature)
        .into_vec()
        .map_err(|_| BurnError::InvalidBurnTransaction)?;
    require!(tx_bytes.len() == 64, BurnError::InvalidBurnTransaction);

    // v14.5: Phase-transitioned tracker must not accept new burns.
    require!(!burn_tracker.phase_transitioned, BurnError::PhaseTransitioned);

    // Update burn tracker
    burn_tracker.total_1dev_burned = burn_tracker.total_1dev_burned
        .checked_add(amount)
        .ok_or(BurnError::Overflow)?;
    burn_tracker.total_burn_transactions = burn_tracker.total_burn_transactions
        .checked_add(1)
        .ok_or(BurnError::Overflow)?;

    // Update burn_percentage in burn_tracker
    burn_tracker.update_burn_percentage();
    burn_tracker.last_update = clock.unix_timestamp;

    // Create burn record (verified via authority signer — see account struct)
    burn_record.solana_tx_signature = tx_signature;
    burn_record.one_dev_amount = amount;
    burn_record.burner_wallet = ctx.accounts.burner.key();
    burn_record.qnet_node_activated = None;
    burn_record.burn_timestamp = clock.unix_timestamp;
    burn_record.solana_block_height = clock.slot;
    // v14.5: `verified` now reflects authority attestation (via Signer<'info>).
    burn_record.verified = true;
    burn_record.bump = ctx.bumps.burn_record;

    msg!("Burn recorded (v14.5: authority-attested)");
    msg!("Amount: {} 1DEV", amount);
    msg!("Total burned: {} 1DEV", burn_tracker.total_1dev_burned);
    msg!("Burn percentage: {:.2}%", burn_tracker.burn_percentage);

    Ok(())
}
