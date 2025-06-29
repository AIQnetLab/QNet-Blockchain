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
} 