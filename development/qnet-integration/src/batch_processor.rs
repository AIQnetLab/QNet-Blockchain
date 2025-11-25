//! Batch transaction processor for high performance
//! PRODUCTION: All transactions are always validated (signature, balance, nonce)

use qnet_state::transaction::Transaction;
use qnet_mempool::Mempool;
use std::sync::Arc;
use tokio::sync::RwLock;
use crate::errors::QNetError;

/// Batch processor for high-performance transaction handling
/// PRODUCTION: Always validates all transactions for security
pub struct BatchProcessor {
    mempool: Arc<RwLock<Mempool>>,
    batch_size: usize,
}

impl BatchProcessor {
    /// Create new batch processor
    pub fn new(mempool: Arc<RwLock<Mempool>>, batch_size: usize) -> Self {
        Self {
            mempool,
            batch_size,
        }
    }
    
    /// Process a batch of transactions
    /// PRODUCTION: All transactions are validated (signature, balance, nonce)
    pub async fn process_batch(&self, transactions: Vec<Transaction>) -> Result<Vec<String>, QNetError> {
        let mut results = Vec::with_capacity(transactions.len());
        
        for tx in transactions {
            let hash = hex::encode(&tx.hash);
            let mempool = self.mempool.write().await;
            
            // PRODUCTION: add_transaction validates signature, balance, nonce
            if let Err(e) = mempool.add_transaction(tx).await {
                eprintln!("Failed to add transaction: {}", e);
            } else {
                results.push(hash);
            }
        }
        
        Ok(results)
    }
    
    /// Process transactions in parallel batches
    pub async fn process_parallel(&self, transactions: Vec<Transaction>) -> Result<Vec<String>, QNetError> {
        use futures::future::join_all;
        
        let chunks: Vec<Vec<Transaction>> = transactions
            .chunks(self.batch_size)
            .map(|chunk| chunk.to_vec())
            .collect();
        
        let futures = chunks.into_iter().map(|batch| {
            let processor = self.clone();
            async move {
                processor.process_batch(batch).await
            }
        });
        
        let results = join_all(futures).await;
        
        let mut all_hashes = Vec::new();
        for result in results {
            match result {
                Ok(hashes) => all_hashes.extend(hashes),
                Err(e) => eprintln!("Batch processing error: {}", e),
            }
        }
        
        Ok(all_hashes)
    }
}

impl Clone for BatchProcessor {
    fn clone(&self) -> Self {
        Self {
            mempool: self.mempool.clone(),
            batch_size: self.batch_size,
        }
    }
}
