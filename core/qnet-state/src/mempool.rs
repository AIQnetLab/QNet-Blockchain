pub fn add_transaction(&mut self, transaction: Transaction) -> Result<(), MempoolError> {
    println!("[DEBUG] Adding transaction to mempool: {:?}", 
        if transaction.hash.len() >= 8 { &transaction.hash[..8] } else { &transaction.hash });
        
    // Validate transaction
    if !self.validate_transaction(&transaction) {
        println!("[DEBUG] Transaction validation failed");
        return Err(MempoolError::InvalidTransaction);
    }
    
    // Check if transaction already exists
    if self.transactions.contains_key(&transaction.hash) {
        println!("[DEBUG] Transaction already exists in mempool");
        return Err(MempoolError::DuplicateTransaction);
    }
    
    // Check mempool size
    if self.transactions.len() >= self.max_size {
        println!("[DEBUG] Mempool is full, removing oldest transaction");
        self.remove_oldest_transaction();
    }
    
    // Add transaction
    self.transactions.insert(transaction.hash.clone(), transaction);
    println!("[DEBUG] Transaction added successfully. Current mempool size: {}", self.transactions.len());
    
    Ok(())
}

pub fn remove_transaction(&mut self, hash: &str) -> Option<Transaction> {
    println!("[DEBUG] Attempting to remove transaction: {:?}", 
        if hash.len() >= 8 { &hash[..8] } else { hash });
        
    let removed = self.transactions.remove(hash);
    
    if removed.is_some() {
        println!("[DEBUG] Transaction removed successfully");
    } else {
        println!("[DEBUG] Transaction not found in mempool");
    }
    
    removed
}

fn validate_transaction(&self, transaction: &Transaction) -> bool {
    println!("[DEBUG] Validating transaction: {:?}", 
        if transaction.hash.len() >= 8 { &transaction.hash[..8] } else { &transaction.hash });
        
    // Check hash is not empty
    if transaction.hash.is_empty() {
        println!("[DEBUG] Transaction validation failed: empty hash");
        return false;
    }
    
    // Check hash length
    if transaction.hash.len() < 8 {
        println!("[DEBUG] Transaction validation failed: invalid hash length");
        return false;
    }
    
    // Check signature
    if !self.verify_signature(transaction) {
        println!("[DEBUG] Transaction validation failed: invalid signature");
        return false;
    }
    
    println!("[DEBUG] Transaction validation successful");
    true
} 