use anchor_lang::prelude::*;

#[error_code]
pub enum BurnError {
    #[msg("Invalid amount")]
    InvalidAmount,
    
    #[msg("Arithmetic overflow")]
    Overflow,
    
    #[msg("Unauthorized")]
    Unauthorized,
    
    #[msg("Invalid burn address")]
    InvalidBurnAddress,
    
    #[msg("Contract is paused")]
    ContractPaused,
    
    #[msg("Phase has already transitioned")]
    PhaseTransitioned,
    
    #[msg("Invalid mint address")]
    InvalidMint,
    
    #[msg("Invalid burn transaction")]
    InvalidBurnTransaction,
    
    #[msg("Insufficient burn amount")]
    InsufficientBurnAmount,
    
    #[msg("Duplicate burn transaction")]
    DuplicateBurnTransaction,
    
    #[msg("Burn not verified")]
    BurnNotVerified,
    
    #[msg("Math overflow")]
    MathOverflow,
} 