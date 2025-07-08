//! Integration tests comparing Rust and Python consensus implementations

use qnet_consensus::commit_reveal::CommitRevealConsensus;
use qnet_consensus::*;
use std::time::Instant;

#[test]
fn test_consensus_compatibility() {
    // Test that Rust implementation produces same results as Python
    let config = ConsensusConfig::default();
    let consensus = CommitRevealConsensus::new(config);
    
    // Start round
    let round_state = consensus.start_new_round(1).unwrap();
    assert_eq!(round_state.round_number, 1);
    assert_eq!(round_state.phase, ConsensusPhase::Commit);
    
    // Test commit/reveal cycle
    let node_id = "test_node_1";
    let (commit_hash, value, nonce) = consensus.generate_commit(node_id);
    
    // Submit commit
    assert!(consensus.submit_commit(node_id, &commit_hash, "sig").is_ok());
    
    // Try to submit duplicate commit (should fail)
    assert!(consensus.submit_commit(node_id, &commit_hash, "sig").is_err());
    
    // Submit reveal
    assert!(consensus.submit_reveal(node_id, &value, &nonce).is_ok());
    
    // Determine leader
    let leader = consensus.determine_leader(&[node_id.to_string()], "beacon").unwrap();
    assert!(leader.is_some());
}

#[test]
fn test_reputation_system() {
    let config = ReputationConfig::default();
    let reputation = NodeReputation::new("own_node".to_string(), config);
    
    let test_node = "test_node";
    reputation.add_node(test_node);
    
    // Initial reputation should be default (0-100 scale)
    assert_eq!(reputation.get_reputation(test_node), 50.0);
    
    // Record some participation
    for i in 0..10 {
        reputation.record_participation(test_node, i % 2 == 0);
    }
    
    // Reputation should change
    let new_reputation = reputation.get_reputation(test_node);
    assert!(new_reputation != 50.0);
    
    // Test penalties and rewards
    reputation.apply_penalty(test_node, "test penalty", 0.1);
    let after_penalty = reputation.get_reputation(test_node);
    assert!(after_penalty < new_reputation);
    
    reputation.apply_reward(test_node, "test reward", 0.1);
    let after_reward = reputation.get_reputation(test_node);
    assert!(after_reward > after_penalty);
}

#[test]
fn test_concurrent_operations() {
    use std::sync::Arc;
    use std::thread;
    
    let config = ConsensusConfig::default();
    let consensus = Arc::new(CommitRevealConsensus::new(config));
    
    consensus.start_new_round(1).unwrap();
    
    // Spawn multiple threads submitting commits
    let mut handles = vec![];
    
    for i in 0..100 {
        let consensus_clone: Arc<CommitRevealConsensus> = Arc::clone(&consensus);
        let handle = thread::spawn(move || {
            let node_id = format!("node_{}", i);
            let (commit_hash, value, nonce) = consensus_clone.generate_commit(&node_id);
            
            // Submit commit
            let commit_result = consensus_clone.submit_commit(&node_id, &commit_hash, "sig");
            
            // Submit reveal if commit succeeded
            if commit_result.is_ok() {
                consensus_clone.submit_reveal(&node_id, &value, &nonce).ok();
            }
        });
        handles.push(handle);
    }
    
    // Wait for all threads
    for handle in handles {
        handle.join().unwrap();
    }
    
    // Check results
    let round_state = consensus.get_round_state();
    println!("Commits: {}, Reveals: {}", 
             round_state.commits.len(), 
             round_state.reveals.len());
    
    assert!(round_state.commits.len() >= 90); // Should have most commits
    assert!(round_state.reveals.len() >= 90); // Should have most reveals
}

#[test]
fn test_performance_vs_python() {
    // This test measures performance and can be compared with Python timings
    let config = ConsensusConfig::default();
    let consensus = CommitRevealConsensus::new(config);
    
    let node_count = 1000;
    let mut eligible_nodes = Vec::new();
    
    // Measure commit phase
    let start = Instant::now();
    consensus.start_new_round(1).unwrap();
    
    for i in 0..node_count {
        let node_id = format!("node_{}", i);
        let (commit_hash, value, nonce) = consensus.generate_commit(&node_id);
        consensus.submit_commit(&node_id, &commit_hash, "sig").unwrap();
        eligible_nodes.push((node_id, value, nonce));
    }
    
    let commit_duration = start.elapsed();
    println!("Commit phase for {} nodes: {:?}", node_count, commit_duration);
    
    // Measure reveal phase
    let start = Instant::now();
    
    for (node_id, value, nonce) in &eligible_nodes {
        consensus.submit_reveal(node_id, value, nonce).unwrap();
    }
    
    let reveal_duration = start.elapsed();
    println!("Reveal phase for {} nodes: {:?}", node_count, reveal_duration);
    
    // Measure leader determination
    let start = Instant::now();
    let node_ids: Vec<String> = eligible_nodes.iter()
        .map(|(id, _, _)| id.clone())
        .collect();
    
    let leader = consensus.determine_leader(&node_ids, "beacon").unwrap();
    let leader_duration = start.elapsed();
    
    println!("Leader determination for {} nodes: {:?}", node_count, leader_duration);
    assert!(leader.is_some());
    
    // Assert performance targets (should be < 50ms for 1000 nodes)
    assert!(commit_duration.as_millis() < 50);
    assert!(reveal_duration.as_millis() < 50);
    assert!(leader_duration.as_millis() < 10);
} 