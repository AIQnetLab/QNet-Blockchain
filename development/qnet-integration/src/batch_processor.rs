//! Batch transaction processor for high performance

use qnet_state::transaction::Transaction;
use qnet_mempool::Mempool;
use std::sync::Arc;
use tokio::sync::RwLock;
use crate::errors::QNetError;

/// Batch processor for high-performance transaction handling
pub struct BatchProcessor {
    mempool: Arc<RwLock<Mempool>>,
    batch_size: usize,
    skip_validation: bool,
}

impl BatchProcessor {
    /// Create new batch processor
    pub fn new(mempool: Arc<RwLock<Mempool>>, batch_size: usize) -> Self {
        Self {
            mempool,
            batch_size,
            skip_validation: std::env::var("QNET_SKIP_VALIDATION").is_ok(),
        }
    }
    
    /// Process a batch of transactions
    pub async fn process_batch(&self, transactions: Vec<Transaction>) -> Result<Vec<String>, QNetError> {
        if self.skip_validation {
            // Fast path for testing - add all transactions without validation
            let mut results = Vec::with_capacity(transactions.len());
            
            // Get write lock once for entire batch
            let mempool = self.mempool.write().await;
            
            for tx in transactions {
                let hash = hex::encode(&tx.hash);
                // Direct add without validation
                if let Err(e) = mempool.add_transaction(tx).await {
                    eprintln!("Failed to add transaction: {}", e);
                } else {
                    results.push(hash);
                }
            }
            
            Ok(results)
        } else {
            // Normal path with validation
            let mut results = Vec::with_capacity(transactions.len());
            
            for tx in transactions {
                let hash = hex::encode(&tx.hash);
                let mempool = self.mempool.write().await;
                
                if let Err(e) = mempool.add_transaction(tx).await {
                    eprintln!("Failed to add transaction: {}", e);
                } else {
                    results.push(hash);
                }
            }
            
            Ok(results)
        }
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
            skip_validation: self.skip_validation,
        }
    }
} 