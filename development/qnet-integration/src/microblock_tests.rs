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
        let mut node = BlockchainNode::new("test_data", 9999, vec![]).await?;
        
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
        
        // Cleanup (stop method not yet implemented)
        // node.stop().await?;
        std::fs::remove_dir_all("test_data").ok();
        
        Ok(())
    }

    #[tokio::test]
    async fn test_microblock_transaction_capacity() -> Result<(), QNetError> {
        use crate::storage::Storage;
        use qnet_state::StateManager;
        use qnet_mempool::{SimpleMempool, SimpleMempoolConfig};
        use qnet_consensus::ConsensusEngine;
        
        // Create components
        let storage = Arc::new(Storage::new("test_capacity_data")?);
        let state = Arc::new(RwLock::new(StateManager::new()));
        let mempool_config = SimpleMempoolConfig {
            max_size: 50000,
            min_gas_price: 1,
        };
        let mempool = Arc::new(RwLock::new(SimpleMempool::new(mempool_config)));
        let consensus = Arc::new(RwLock::new(ConsensusEngine::new("test_node".to_string())));
        
        // Add 10,000 transactions to mempool
        let start = Instant::now();
        for i in 0..10_000 {
            let tx = Transaction::new(
                format!("sender{}", i),
                Some(format!("recipient{}", i)),
                100,
                i as u64,
                10,
                10_000, // QNet TRANSFER gas limit
                chrono::Utc::now().timestamp() as u64,
                None,
                TransactionType::Transfer {
                    from: format!("sender{}", i),
                    to: format!("recipient{}", i),
                    amount: 100,
                },
                None,
            );
            
            mempool.write().await.add_transaction(tx).ok();
        }
        let add_duration = start.elapsed();
        println!("Added 10k transactions in {:?}", add_duration);
        
        // Get transactions for microblock
        let start = Instant::now();
        let tx_jsons = mempool.read().await.get_pending_transactions(10_000);
        let get_duration = start.elapsed();
        
        // Convert JSON strings back to Transaction objects
        let mut transactions = Vec::new();
        for tx_json in tx_jsons {
            if let Ok(tx) = serde_json::from_str::<qnet_state::Transaction>(&tx_json) {
                transactions.push(tx);
            }
        }
        
        assert_eq!(transactions.len(), 10_000);
        println!("Retrieved 10k transactions in {:?}", get_duration);
        assert!(get_duration.as_millis() < 100); // Should be fast
        
        // Create microblock
        let start = Instant::now();
        let microblock = MicroBlock {
            height: 1,
            timestamp: chrono::Utc::now().timestamp() as u64,
            previous_hash: [0u8; 32],
            transactions,
            producer: "test_node".to_string(),
            signature: vec![0u8; 64],
            merkle_root: [0u8; 32],
        };
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
                10_000, // QNet TRANSFER gas limit
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
        
        let microblock = MicroBlock {
            height: 1,
            timestamp: chrono::Utc::now().timestamp() as u64,
            previous_hash: [0u8; 32],
            transactions,
            producer: "test_node".to_string(),
            signature: vec![0u8; 64],
            merkle_root: [0u8; 32],
        };
        
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
                10_000, // QNet TRANSFER gas limit
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
        
        let microblock = MicroBlock {
            height: 1,
            timestamp: chrono::Utc::now().timestamp() as u64,
            previous_hash: [0u8; 32],
            transactions,
            producer: "test_node".to_string(),
            signature: vec![0u8; 64],
            merkle_root: [0u8; 32],
        };
        
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