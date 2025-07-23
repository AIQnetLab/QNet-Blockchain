use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use borsh::{BorshDeserialize, BorshSerialize};

// Program entry point
entrypoint!(process_instruction);

// Program ID - this will be updated after deployment
solana_program::declare_id!("D7g7mkL8o1YEex6ZgETJEQyyHV7uuUMvV3Fy3u83igJ7");

#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct BurnData {
    pub total_burned: u64,
    pub burn_count: u64,
}

/// Instruction processing
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let account = next_account_info(accounts_iter)?;

    // Simple burn tracking logic
    match instruction_data[0] {
        0 => {
            // Initialize burn tracker
            msg!("Initializing 1DEV burn tracker");
            let burn_data = BurnData {
                total_burned: 0,
                burn_count: 0,
            };
            burn_data.serialize(&mut &mut account.data.borrow_mut()[..])?;
        }
        1 => {
            // Record burn
            if instruction_data.len() < 9 {
                return Err(ProgramError::InvalidInstructionData);
            }
            
            let amount = u64::from_le_bytes([
                instruction_data[1], instruction_data[2], instruction_data[3], 
                instruction_data[4], instruction_data[5], instruction_data[6], 
                instruction_data[7], instruction_data[8]
            ]);
            
            let mut burn_data = BurnData::try_from_slice(&account.data.borrow())?;
            burn_data.total_burned = burn_data.total_burned.saturating_add(amount);
            burn_data.burn_count = burn_data.burn_count.saturating_add(1);
            
            msg!("Recorded burn: {} tokens, total: {}", amount, burn_data.total_burned);
            burn_data.serialize(&mut &mut account.data.borrow_mut()[..])?;
        }
        _ => {
            msg!("Invalid instruction");
            return Err(ProgramError::InvalidInstructionData);
        }
    }

    Ok(())
} 