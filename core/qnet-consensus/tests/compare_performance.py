#!/usr/bin/env python3
"""
Compare performance between Python and Rust consensus implementations
"""

import time
import sys
import os
from typing import List, Tuple

# Add Python consensus to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../qnet-core/src'))

# Import Python consensus
from consensus.consensus import CommitRevealConsensus as PythonConsensus
from consensus.reputation_consensus import NodeReputation as PythonReputation

# Import Rust consensus (if built)
try:
    import qnet_consensus_rust
    RUST_AVAILABLE = True
except ImportError:
    print("Warning: Rust consensus not available. Run 'maturin develop --features python' first.")
    RUST_AVAILABLE = False

class PerformanceTest:
    def __init__(self, node_count: int = 1000):
        self.node_count = node_count
        self.results = {}
    
    def test_python_consensus(self):
        """Test Python consensus performance"""
        print(f"\n=== Testing Python Consensus with {self.node_count} nodes ===")
        
        # Mock config for Python version
        class MockConfig:
            def getint(self, section, key, fallback=None):
                return fallback
            def getfloat(self, section, key, fallback=None):
                return fallback
            def getboolean(self, section, key, fallback=None):
                return fallback
        
        consensus = PythonConsensus(MockConfig())
        
        # Start round
        start = time.time()
        consensus.start_new_round(1)
        round_start_time = time.time() - start
        
        # Commit phase
        commits = []
        start = time.time()
        for i in range(self.node_count):
            node_id = f"node_{i}"
            commit_hash, value, nonce = consensus.generate_commit(node_id)
            success, _ = consensus.submit_commit(node_id, commit_hash, "dummy_sig")
            if success:
                commits.append((node_id, value, nonce))
        commit_time = time.time() - start
        
        # Reveal phase
        start = time.time()
        for node_id, value, nonce in commits:
            consensus.submit_reveal(node_id, value, nonce)
        reveal_time = time.time() - start
        
        # Leader determination
        eligible_nodes = [c[0] for c in commits]
        start = time.time()
        leader = consensus.determine_leader(eligible_nodes, "test_beacon")
        leader_time = time.time() - start
        
        self.results['python'] = {
            'round_start': round_start_time,
            'commit_phase': commit_time,
            'reveal_phase': reveal_time,
            'leader_determination': leader_time,
            'total': round_start_time + commit_time + reveal_time + leader_time,
            'commits': len(commits),
            'leader': leader
        }
        
        print(f"Round start: {round_start_time:.3f}s")
        print(f"Commit phase: {commit_time:.3f}s ({len(commits)} commits)")
        print(f"Reveal phase: {reveal_time:.3f}s")
        print(f"Leader determination: {leader_time:.3f}s")
        print(f"Total: {self.results['python']['total']:.3f}s")
    
    def test_rust_consensus(self):
        """Test Rust consensus performance"""
        if not RUST_AVAILABLE:
            print("\n=== Skipping Rust Consensus (not available) ===")
            return
        
        print(f"\n=== Testing Rust Consensus with {self.node_count} nodes ===")
        
        # Create config
        config = qnet_consensus_rust.PyConsensusConfig()
        consensus = qnet_consensus_rust.PyCommitRevealConsensus(config)
        
        # Start round
        start = time.time()
        consensus.start_new_round(1)
        round_start_time = time.time() - start
        
        # Commit phase
        commits = []
        start = time.time()
        for i in range(self.node_count):
            node_id = f"node_{i}"
            commit_hash, value, nonce = consensus.generate_commit(node_id)
            success = consensus.submit_commit(node_id, commit_hash, "dummy_sig")
            if success:
                commits.append((node_id, value, nonce))
        commit_time = time.time() - start
        
        # Reveal phase
        start = time.time()
        for node_id, value, nonce in commits:
            consensus.submit_reveal(node_id, value, nonce)
        reveal_time = time.time() - start
        
        # Leader determination
        eligible_nodes = [c[0] for c in commits]
        start = time.time()
        leader = consensus.determine_leader(eligible_nodes, "test_beacon")
        leader_time = time.time() - start
        
        self.results['rust'] = {
            'round_start': round_start_time,
            'commit_phase': commit_time,
            'reveal_phase': reveal_time,
            'leader_determination': leader_time,
            'total': round_start_time + commit_time + reveal_time + leader_time,
            'commits': len(commits),
            'leader': leader
        }
        
        print(f"Round start: {round_start_time:.3f}s")
        print(f"Commit phase: {commit_time:.3f}s ({len(commits)} commits)")
        print(f"Reveal phase: {reveal_time:.3f}s")
        print(f"Leader determination: {leader_time:.3f}s")
        print(f"Total: {self.results['rust']['total']:.3f}s")
    
    def compare_results(self):
        """Compare and display results"""
        if 'python' not in self.results:
            print("\nNo Python results to compare")
            return
        
        if 'rust' not in self.results:
            print("\nNo Rust results to compare")
            return
        
        print("\n=== Performance Comparison ===")
        print(f"{'Operation':<20} {'Python':>10} {'Rust':>10} {'Speedup':>10}")
        print("-" * 52)
        
        for op in ['round_start', 'commit_phase', 'reveal_phase', 'leader_determination', 'total']:
            py_time = self.results['python'][op]
            rust_time = self.results['rust'][op]
            speedup = py_time / rust_time if rust_time > 0 else float('inf')
            
            print(f"{op:<20} {py_time:>10.3f}s {rust_time:>10.3f}s {speedup:>10.1f}x")
        
        print(f"\nBoth selected same leader: {self.results['python']['leader'] == self.results['rust']['leader']}")
    
    def test_reputation_performance(self):
        """Test reputation system performance"""
        print(f"\n=== Testing Reputation System with {self.node_count} nodes ===")
        
        # Python reputation
        print("\nPython Reputation:")
        py_rep = PythonReputation("own_node", MockConfig())
        
        # Add nodes
        start = time.time()
        for i in range(self.node_count):
            py_rep.add_node(f"node_{i}")
        py_add_time = time.time() - start
        
        # Record participation
        start = time.time()
        for i in range(self.node_count):
            py_rep.record_participation(f"node_{i}", i % 2 == 0)
        py_record_time = time.time() - start
        
        # Get all reputations
        start = time.time()
        py_all_reps = py_rep.get_all_reputations()
        py_get_all_time = time.time() - start
        
        print(f"Add nodes: {py_add_time:.3f}s")
        print(f"Record participation: {py_record_time:.3f}s")
        print(f"Get all reputations: {py_get_all_time:.3f}s")
        
        if RUST_AVAILABLE:
            print("\nRust Reputation:")
            rust_rep = qnet_consensus_rust.PyNodeReputation("own_node")
            
            # Add nodes
            start = time.time()
            for i in range(self.node_count):
                rust_rep.add_node(f"node_{i}")
            rust_add_time = time.time() - start
            
            # Record participation
            start = time.time()
            for i in range(self.node_count):
                rust_rep.record_participation(f"node_{i}", i % 2 == 0)
            rust_record_time = time.time() - start
            
            # Get all reputations
            start = time.time()
            rust_all_reps = rust_rep.get_all_reputations()
            rust_get_all_time = time.time() - start
            
            print(f"Add nodes: {rust_add_time:.3f}s")
            print(f"Record participation: {rust_record_time:.3f}s")
            print(f"Get all reputations: {rust_get_all_time:.3f}s")
            
            print(f"\nSpeedup: {py_add_time/rust_add_time:.1f}x (add), "
                  f"{py_record_time/rust_record_time:.1f}x (record), "
                  f"{py_get_all_time/rust_get_all_time:.1f}x (get all)")

def main():
    # Test with different node counts
    for node_count in [100, 1000, 5000]:
        test = PerformanceTest(node_count)
        test.test_python_consensus()
        test.test_rust_consensus()
        test.compare_results()
        test.test_reputation_performance()
        print("\n" + "="*60 + "\n")

if __name__ == "__main__":
    main() 