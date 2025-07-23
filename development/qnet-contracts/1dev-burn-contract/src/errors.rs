use anchor_lang::prelude::*;

#[error_code]
pub enum BurnError {
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Insufficient 1DEV burn amount")]
    InsufficientBurnAmount,
    #[msg("Invalid burn transaction")]
    InvalidBurnTransaction,
    #[msg("Node already activated")]
    NodeAlreadyActivated,
    #[msg("Invalid node type")]
    InvalidNodeType,
    #[msg("Contract is paused")]
    ContractPaused,
    #[msg("Phase has already transitioned")]
    PhaseTransitioned,
    #[msg("Invalid burn address")]
    InvalidBurnAddress,
    #[msg("Invalid 1DEV mint")]
    InvalidMint,
    #[msg("Burn not verified")]
    BurnNotVerified,
    #[msg("Duplicate burn transaction")]
    DuplicateBurnTransaction,
    #[msg("Invalid burner address")]
    InvalidBurner,
    #[msg("Phase transition conditions not met")]
    TransitionNotReady,
} 