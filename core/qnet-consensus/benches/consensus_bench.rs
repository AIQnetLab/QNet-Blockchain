use criterion::{black_box, criterion_group, criterion_main, Criterion, BenchmarkId};
use qnet_consensus::{
    CommitRevealConsensus, NodeReputation, ReputationConsensusManager,
    ConsensusConfig, ReputationConfig,
};
use std::sync::Arc;

fn bench_commit_reveal(c: &mut Criterion) {
    let config = ConsensusConfig::default();
    let consensus = CommitRevealConsensus::new(config);
    
    let mut group = c.benchmark_group("commit_reveal");
    
    // Benchmark commit submission
    group.bench_function("submit_commit", |b| {
        let round = consensus.start_new_round(1).unwrap();
        b.iter(|| {
            let node_id = format!("node_{}", rand::random::<u32>());
            let (commit_hash, _, _) = consensus.generate_commit(&node_id);
            let signature = "dummy_signature";
            
            let _ = consensus.submit_commit(
                black_box(&node_id),
                black_box(&commit_hash),
                black_box(signature),
            );
        });
    });
    
    // Benchmark reveal submission
    group.bench_function("submit_reveal", |b| {
        let round = consensus.start_new_round(2).unwrap();
        let node_id = "test_node";
        let (commit_hash, value, nonce) = consensus.generate_commit(node_id);
        let _ = consensus.submit_commit(node_id, &commit_hash, "sig");
        
        b.iter(|| {
            let _ = consensus.submit_reveal(
                black_box(node_id),
                black_box(&value),
                black_box(&nonce),
            );
        });
    });
    
    // Benchmark leader determination with varying node counts
    for node_count in [10, 100, 1000, 10000].iter() {
        group.bench_with_input(
            BenchmarkId::new("determine_leader", node_count),
            node_count,
            |b, &count| {
                let round = consensus.start_new_round(3).unwrap();
                let mut eligible_nodes = Vec::new();
                
                // Setup commits and reveals
                for i in 0..count {
                    let node_id = format!("node_{}", i);
                    let (commit_hash, value, nonce) = consensus.generate_commit(&node_id);
                    let _ = consensus.submit_commit(&node_id, &commit_hash, "sig");
                    let _ = consensus.submit_reveal(&node_id, &value, &nonce);
                    eligible_nodes.push(node_id);
                }
                
                b.iter(|| {
                    let _ = consensus.determine_leader(
                        black_box(&eligible_nodes),
                        black_box("random_beacon"),
                    );
                });
            },
        );
    }
    
    group.finish();
}

fn bench_reputation(c: &mut Criterion) {
    let config = ReputationConfig::default();
    let reputation = Arc::new(NodeReputation::new("own_node".to_string(), config.clone()));
    
    let mut group = c.benchmark_group("reputation");
    
    // Benchmark reputation updates
    group.bench_function("record_participation", |b| {
        let node_id = "test_node";
        reputation.add_node(node_id);
        
        b.iter(|| {
            reputation.record_participation(
                black_box(node_id),
                black_box(rand::random::<bool>()),
            );
        });
    });
    
    group.bench_function("record_response_time", |b| {
        let node_id = "test_node";
        reputation.add_node(node_id);
        
        b.iter(|| {
            reputation.record_response_time(
                black_box(node_id),
                black_box(rand::random::<f64>() * 10.0),
            );
        });
    });
    
    // Benchmark reputation queries with varying node counts
    for node_count in [100, 1000, 10000].iter() {
        group.bench_with_input(
            BenchmarkId::new("get_all_reputations", node_count),
            node_count,
            |b, &count| {
                // Setup nodes
                for i in 0..count {
                    let node_id = format!("node_{}", i);
                    reputation.add_node(&node_id);
                    reputation.record_participation(&node_id, true);
                }
                
                b.iter(|| {
                    let _ = black_box(reputation.get_all_reputations());
                });
            },
        );
    }
    
    group.finish();
}

fn bench_consensus_throughput(c: &mut Criterion) {
    let mut group = c.benchmark_group("throughput");
    group.sample_size(10);
    
    // Benchmark full consensus round with varying node counts
    for node_count in [100, 500, 1000].iter() {
        group.bench_with_input(
            BenchmarkId::new("full_round", node_count),
            node_count,
            |b, &count| {
                let config = ConsensusConfig::default();
                let consensus = CommitRevealConsensus::new(config);
                
                b.iter(|| {
                    let round = consensus.start_new_round(rand::random()).unwrap();
                    let mut eligible_nodes = Vec::new();
                    
                    // Commit phase
                    for i in 0..count {
                        let node_id = format!("node_{}", i);
                        let (commit_hash, value, nonce) = consensus.generate_commit(&node_id);
                        let _ = consensus.submit_commit(&node_id, &commit_hash, "sig");
                        eligible_nodes.push((node_id, value, nonce));
                    }
                    
                    // Reveal phase
                    for (node_id, value, nonce) in &eligible_nodes {
                        let _ = consensus.submit_reveal(node_id, value, nonce);
                    }
                    
                    // Leader determination
                    let node_ids: Vec<String> = eligible_nodes.iter()
                        .map(|(id, _, _)| id.clone())
                        .collect();
                    let _ = consensus.determine_leader(&node_ids, "beacon");
                });
            },
        );
    }
    
    group.finish();
}

criterion_group!(
    benches,
    bench_commit_reveal,
    bench_reputation,
    bench_consensus_throughput
);
criterion_main!(benches); 