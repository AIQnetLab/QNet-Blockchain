#[cfg(test)]
mod microblock_tests {
    use qnet_state::block::{MicroBlock, MacroBlock, BlockType, ConsensusData};
    use qnet_state::transaction::{Transaction, TransactionType};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn test_microblock_creation() {
        // Create test transactions
        let mut transactions = vec![];
        for i in 0..5 {
            let tx = Transaction::new(
                format!("sender{}", i),
                Some(format!("recipient{}", i)),
                100 + i as u64,
                i as u64,
                10,
                21000,
                SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs(),
                None,
                TransactionType::Transfer {
                    from: format!("sender{}", i),
                    to: format!("recipient{}", i),
                    amount: 100 + i as u64,
                },
                None,
            );
            transactions.push(tx);
        }

        // Create microblock
        let microblock = MicroBlock::new(
            1,
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs(),
            [0u8; 32],
            transactions.clone(),
            "test_node".to_string(),
        );

        // Verify microblock
        assert_eq!(microblock.height, 1);
        assert_eq!(microblock.transactions.len(), 5);
        assert_eq!(microblock.producer, "test_node");
        
        // Test hash calculation
        let hash = microblock.hash();
        assert_eq!(hash.len(), 32);
    }

    #[test]
    fn test_macroblock_creation() {
        // Create microblock hashes
        let mut micro_hashes = vec![];
        for i in 0..90 {
            let mut hash = [0u8; 32];
            hash[0] = i as u8;
            micro_hashes.push(hash);
        }

        // Create consensus data
        let consensus_data = ConsensusData {
            commits: vec![],
            reveals: vec![],
            next_leader: "next_leader".to_string(),
        };

        // Create macroblock
        let macroblock = MacroBlock::new(
            1,
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs(),
            [0u8; 32],
            micro_hashes.clone(),
            [1u8; 32], // state root
            consensus_data,
        );

        // Verify macroblock
        assert_eq!(macroblock.height, 1);
        assert_eq!(macroblock.micro_blocks.len(), 90);
        assert_eq!(macroblock.consensus_data.next_leader, "next_leader");
        
        // Test validation
        assert!(macroblock.validate().is_ok());
    }

    #[test]
    fn test_microblock_to_light_header() {
        let microblock = MicroBlock::new(
            100,
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs(),
            [1u8; 32],
            vec![],
            "producer".to_string(),
        );

        let light_header = microblock.to_light_header();
        
        assert_eq!(light_header.height, 100);
        assert_eq!(light_header.previous_hash, [1u8; 32]);
        assert_eq!(light_header.tx_count, 0);
        assert_eq!(light_header.producer, "producer");
    }

    #[test]
    fn test_microblock_performance() {
        use std::time::Instant;
        
        // Create 10,000 transactions (max per microblock)
        let mut transactions = vec![];
        for i in 0..10_000 {
            let tx = Transaction::new(
                format!("sender{}", i),
                Some(format!("recipient{}", i)),
                100,
                i as u64,
                10,
                21000,
                SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs(),
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

        // Measure microblock creation time
        let start = Instant::now();
        let microblock = MicroBlock::new(
            1,
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs(),
            [0u8; 32],
            transactions,
            "test_node".to_string(),
        );
        let duration = start.elapsed();

        println!("Created microblock with 10k transactions in {:?}", duration);
        assert!(duration.as_millis() < 100); // Should be fast
        assert_eq!(microblock.transactions.len(), 10_000);
    }

    #[test]
    fn test_block_type_serialization() {
        use bincode;
        
        let microblock = MicroBlock::new(
            1,
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs(),
            [0u8; 32],
            vec![],
            "test".to_string(),
        );

        let block_type = BlockType::Micro(microblock);
        
        // Test serialization
        let serialized = bincode::serialize(&block_type).unwrap();
        let deserialized: BlockType = bincode::deserialize(&serialized).unwrap();
        
        match deserialized {
            BlockType::Micro(mb) => {
                assert_eq!(mb.height, 1);
                assert_eq!(mb.producer, "test");
            }
            _ => panic!("Wrong block type"),
        }
    }
} 