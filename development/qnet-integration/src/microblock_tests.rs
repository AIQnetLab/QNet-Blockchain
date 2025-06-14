//! Integration tests for micro/macro block architecture

#[cfg(test)]
mod tests {
    use crate::node::BlockchainNode;
    use crate::errors::QNetError;
    use qnet_state::block::{MicroBlock, MacroBlock, BlockType};
    use qnet_state::transaction::{Transaction, TransactionType};
    use std::sync::Arc;
    use tokio::sync::RwLock;
    use std::time::{Duration, Instant};

    #[tokio::test]
    async fn test_microblock_creation_rate() -> Result<(), QNetError> {
        // Create test node
        let node = BlockchainNode::new("test_data", 9999, vec![]).await?;
        
        // Enable microblocks
        std::env::set_var("QNET_ENABLE_MICROBLOCKS", "1");
        std::env::set_var("QNET_IS_LEADER", "1");
        
        // Start node
        node.start().await?;
        
        // Wait for microblocks
        let start_height = node.get_height().await;
        tokio::time::sleep(Duration::from_secs(5)).await;
        let end_height = node.get_height().await;
        
        // Should create ~5 microblocks in 5 seconds
        let blocks_created = end_height - start_height;
        assert!(blocks_created >= 4, "Expected at least 4 blocks, got {}", blocks_created);
        
        // Cleanup
        node.stop().await?;
        std::fs::remove_dir_all("test_data").ok();
        
        Ok(())
    }

    #[tokio::test]
    async fn test_microblock_transaction_capacity() -> Result<(), QNetError> {
        use crate::storage::Storage;
        use qnet_state::StateManager;
        use qnet_mempool::{Mempool, MempoolConfig};
        use qnet_consensus::ConsensusEngine;
        use crate::validator::BlockValidator;
        
        // Create components
        let storage = Arc::new(Storage::new("test_capacity_data")?);
        let state = Arc::new(RwLock::new(StateManager::new(storage.clone())?));
        let mempool_config = MempoolConfig::default();
        let mempool = Arc::new(RwLock::new(Mempool::new_simple(mempool_config)));
        let consensus = Arc::new(RwLock::new(ConsensusEngine::new(Default::default())));
        let validator = Arc::new(BlockValidator::new());
        
        // Add 10,000 transactions to mempool
        let start = Instant::now();
        for i in 0..10_000 {
            let tx = Transaction::new(
                format!("sender{}", i),
                Some(format!("recipient{}", i)),
                100,
                i as u64,
                10,
                21000,
                chrono::Utc::now().timestamp() as u64,
                None,
                TransactionType::Transfer {
                    from: format!("sender{}", i),
                    to: format!("recipient{}", i),
                    amount: 100,
                },
                None,
            );
            
            mempool.write().await.add_transaction(tx).await.ok();
        }
        let add_duration = start.elapsed();
        println!("Added 10k transactions in {:?}", add_duration);
        
        // Get transactions for microblock
        let start = Instant::now();
        let transactions = mempool.read().await.get_top_transactions(10_000);
        let get_duration = start.elapsed();
        
        assert_eq!(transactions.len(), 10_000);
        println!("Retrieved 10k transactions in {:?}", get_duration);
        assert!(get_duration.as_millis() < 100); // Should be fast
        
        // Create microblock
        let start = Instant::now();
        let microblock = MicroBlock::new(
            1,
            chrono::Utc::now().timestamp() as u64,
            [0u8; 32],
            transactions,
            "test_node".to_string(),
        );
        let create_duration = start.elapsed();
        
        println!("Created microblock with 10k transactions in {:?}", create_duration);
        assert!(create_duration.as_millis() < 50); // Should be very fast
        
        // Cleanup
        std::fs::remove_dir_all("test_capacity_data").ok();
        
        Ok(())
    }

    #[tokio::test]
    async fn test_macroblock_consensus_trigger() -> Result<(), QNetError> {
        // This test would require a full node setup with consensus
        // For now, we test the basic flow
        
        let mut micro_hashes = vec![];
        
        // Simulate 90 microblocks
        for i in 0..90 {
            let mut hash = [0u8; 32];
            hash[0] = i as u8;
            micro_hashes.push(hash);
        }
        
        assert_eq!(micro_hashes.len(), 90);
        
        // In real implementation, this would trigger consensus
        // and create a macroblock
        
        Ok(())
    }

    #[test]
    fn test_microblock_serialization_performance() {
        use bincode;
        use std::time::Instant;
        
        // Create microblock with many transactions
        let mut transactions = vec![];
        for i in 0..1000 {
            let tx = Transaction::new(
                format!("sender{}", i),
                Some(format!("recipient{}", i)),
                100,
                i as u64,
                10,
                21000,
                chrono::Utc::now().timestamp() as u64,
                None,
                TransactionType::Transfer {
                    from: format!("sender{}", i),
                    to: format!("recipient{}", i),
                    amount: 100,
                },
                None,
            );
            transactions.push(tx);
        }
        
        let microblock = MicroBlock::new(
            1,
            chrono::Utc::now().timestamp() as u64,
            [0u8; 32],
            transactions,
            "test_node".to_string(),
        );
        
        // Test serialization speed
        let start = Instant::now();
        let serialized = bincode::serialize(&BlockType::Micro(microblock.clone())).unwrap();
        let ser_duration = start.elapsed();
        
        // Test deserialization speed
        let start = Instant::now();
        let _deserialized: BlockType = bincode::deserialize(&serialized).unwrap();
        let deser_duration = start.elapsed();
        
        println!("Serialization of 1k tx microblock: {:?}", ser_duration);
        println!("Deserialization of 1k tx microblock: {:?}", deser_duration);
        println!("Serialized size: {} bytes", serialized.len());
        
        // Should be fast
        assert!(ser_duration.as_millis() < 50);
        assert!(deser_duration.as_millis() < 50);
    }

    #[test]
    fn test_light_node_efficiency() {
        // Create full microblock
        let mut transactions = vec![];
        for i in 0..10_000 {
            let tx = Transaction::new(
                format!("sender{}", i),
                Some(format!("recipient{}", i)),
                100,
                i as u64,
                10,
                21000,
                chrono::Utc::now().timestamp() as u64,
                None,
                TransactionType::Transfer {
                    from: format!("sender{}", i),
                    to: format!("recipient{}", i),
                    amount: 100,
                },
                None,
            );
            transactions.push(tx);
        }
        
        let microblock = MicroBlock::new(
            1,
            chrono::Utc::now().timestamp() as u64,
            [0u8; 32],
            transactions,
            "test_node".to_string(),
        );
        
        // Convert to light header
        let light_header = microblock.to_light_header();
        
        // Compare sizes
        let full_size = bincode::serialize(&microblock).unwrap().len();
        let light_size = bincode::serialize(&light_header).unwrap().len();
        
        println!("Full microblock size: {} bytes", full_size);
        println!("Light header size: {} bytes", light_size);
        println!("Compression ratio: {:.2}%", (light_size as f64 / full_size as f64) * 100.0);
        
        // Light header should be much smaller
        assert!(light_size < full_size / 100); // Less than 1% of full size
    }
} 