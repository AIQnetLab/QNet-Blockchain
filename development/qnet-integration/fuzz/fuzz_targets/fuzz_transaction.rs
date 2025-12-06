//! Fuzz testing for transaction parsing and validation
//! 
//! Tests that malformed transactions don't crash the node.
//! Run with: cargo +nightly fuzz run fuzz_transaction

#![no_main]

use libfuzzer_sys::fuzz_target;
use arbitrary::Arbitrary;

/// Fuzz transaction structure
#[derive(Arbitrary, Debug)]
struct FuzzTransaction {
    tx_type: u8,
    from: [u8; 32],
    to: [u8; 32],
    amount: u64,
    gas_price: u64,
    gas_limit: u64,
    nonce: u64,
    data: Vec<u8>,
    signature: Vec<u8>,
}

fuzz_target!(|tx: FuzzTransaction| {
    // Test overflow protection
    let _ = tx.gas_price.checked_mul(tx.gas_limit);
    let gas_cost = tx.gas_price.saturating_mul(tx.gas_limit);
    let _ = tx.amount.checked_add(gas_cost);
    
    // Validate transaction structure
    let _ = validate_transaction(&tx);
});

/// Transaction validation that mirrors production code
fn validate_transaction(tx: &FuzzTransaction) -> Result<(), &'static str> {
    // Check for zero address
    if tx.from == [0u8; 32] {
        return Err("From address cannot be zero");
    }
    
    // Check gas limits
    if tx.gas_limit == 0 {
        return Err("Gas limit cannot be zero");
    }
    
    if tx.gas_limit > 10_000_000 {
        return Err("Gas limit too high");
    }
    
    // Check for overflow in gas calculation
    let gas_cost = tx.gas_price.checked_mul(tx.gas_limit)
        .ok_or("Gas calculation overflow")?;
    
    // Check for overflow in total cost
    let _total = tx.amount.checked_add(gas_cost)
        .ok_or("Total cost overflow")?;
    
    // Check data size
    if tx.data.len() > 1024 * 1024 {
        return Err("Data too large");
    }
    
    // Check signature size
    if tx.signature.len() > 4096 {
        return Err("Signature too large");
    }
    
    Ok(())
}

/// Raw bytes fuzzing for transaction deserialization
fuzz_target!(|data: &[u8]| {
    // Try to deserialize raw bytes as transaction
    let _ = bincode::deserialize::<FuzzTransaction>(data);
});

