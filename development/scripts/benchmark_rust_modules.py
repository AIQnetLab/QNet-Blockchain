#!/usr/bin/env python3
"""Benchmark Rust modules performance."""

import time
import asyncio
import random
import string
import tempfile
import shutil
from pathlib import Path

# Try to import Rust modules
try:
    import qnet_consensus_rust
    import qnet_state_rust
    import qnet_mempool_rust
    RUST_AVAILABLE = True
except ImportError:
    print("Rust modules not available. Please build them first:")
    print("  python build_python_bindings.py")
    RUST_AVAILABLE = False
    exit(1)


def generate_random_address():
    """Generate random address."""
    return ''.join(random.choices(string.ascii_letters + string.digits, k=32))


def benchmark_consensus():
    """Benchmark consensus operations."""
    print("\n" + "="*60)
    print("Benchmarking Consensus Module")
    print("="*60)
    
    # Create consensus instance
    config = qnet_consensus_rust.ConsensusConfig(
        commit_duration_ms=1000,
        reveal_duration_ms=500,
                        reputation_threshold=50.0
    )
    consensus = qnet_consensus_rust.CommitRevealConsensus(config)
    
    # Benchmark commit generation
    start = time.time()
    commits = []
    for i in range(1000):
        commit = consensus.generate_commit()
        commits.append(commit)
    commit_time = time.time() - start
    print(f"Generated 1000 commits in {commit_time:.3f}s ({1000/commit_time:.0f} commits/sec)")
    
    # Benchmark adding commits
    start = time.time()
    for i, commit in enumerate(commits[:100]):
        node_addr = generate_random_address()
        consensus.add_commit(node_addr, commit['hash'], f"sig_{i}")
    add_commit_time = time.time() - start
    print(f"Added 100 commits in {add_commit_time:.3f}s ({100/add_commit_time:.0f} commits/sec)")
    
    # Benchmark leader selection
    nodes = [generate_random_address() for _ in range(100)]
    start = time.time()
    for i in range(1000):
        leader = consensus.determine_leader(nodes, f"beacon_{i}")
    leader_time = time.time() - start
    print(f"Selected 1000 leaders in {leader_time:.3f}s ({1000/leader_time:.0f} selections/sec)")


def benchmark_state():
    """Benchmark state operations."""
    print("\n" + "="*60)
    print("Benchmarking State Module")
    print("="*60)
    
    # Create temporary directory
    with tempfile.TemporaryDirectory() as tmpdir:
        # Create state DB
        state_db = qnet_state_rust.StateDB(tmpdir)
        
        # Benchmark account operations
        accounts = [generate_random_address() for _ in range(1000)]
        
        # Write accounts
        start = time.time()
        for addr in accounts:
            account = qnet_state_rust.AccountState(balance=random.randint(1000, 1000000))
            state_db.set_account(addr, account)
        write_time = time.time() - start
        print(f"Wrote 1000 accounts in {write_time:.3f}s ({1000/write_time:.0f} accounts/sec)")
        
        # Read accounts
        start = time.time()
        for addr in accounts:
            account = state_db.get_account(addr)
        read_time = time.time() - start
        print(f"Read 1000 accounts in {read_time:.3f}s ({1000/read_time:.0f} accounts/sec)")
        
        # Benchmark block operations
        start = time.time()
        for i in range(100):
            block = qnet_state_rust.Block(
                index=i,
                timestamp=int(time.time()),
                transactions=[],
                previous_hash=f"hash_{i-1}",
                miner="miner_address",
                nonce=0
            )
            state_db.store_block(block)
        block_time = time.time() - start
        print(f"Stored 100 blocks in {block_time:.3f}s ({100/block_time:.0f} blocks/sec)")


async def benchmark_mempool():
    """Benchmark mempool operations."""
    print("\n" + "="*60)
    print("Benchmarking Mempool Module")
    print("="*60)
    
    # Create temporary directory
    with tempfile.TemporaryDirectory() as tmpdir:
        # Create mempool
        config = qnet_mempool_rust.MempoolConfig.default()
        mempool = qnet_mempool_rust.Mempool(config, tmpdir)
        
        # Generate transactions
        transactions = []
        for i in range(10000):
            tx = qnet_mempool_rust.Transaction(
                from_addr=f"sender_{i % 100}",
                tx_type="transfer",
                tx_data={"to": "recipient", "amount": 100},
                nonce=i // 100,
                gas_price=random.randint(1, 100),
                gas_limit=10000,  # QNet TRANSFER gas limit
                timestamp=int(time.time())
            )
            transactions.append(tx)
        
        # Benchmark adding transactions
        start = time.time()
        added = 0
        for tx in transactions[:5000]:
            try:
                await mempool.add_transaction(tx)
                added += 1
            except:
                pass
        add_time = time.time() - start
        print(f"Added {added} transactions in {add_time:.3f}s ({added/add_time:.0f} tx/sec)")
        
        # Benchmark getting top transactions
        start = time.time()
        for _ in range(100):
            top_txs = mempool.get_top_transactions(100)
        get_time = time.time() - start
        print(f"Got top 100 transactions 100 times in {get_time:.3f}s ({100/get_time:.0f} queries/sec)")
        
        # Benchmark mempool size
        size = mempool.size()
        print(f"Mempool size: {size} transactions")
        
        # Get metrics
        metrics = mempool.get_metrics()
        print(f"Mempool metrics: {metrics}")


def main():
    """Run all benchmarks."""
    print("QNet Rust Modules Performance Benchmark")
    print("="*60)
    
    # Run benchmarks
    benchmark_consensus()
    benchmark_state()
    
    # Run async benchmark
    asyncio.run(benchmark_mempool())
    
    print("\n" + "="*60)
    print("Benchmark completed!")
    print("="*60)


if __name__ == "__main__":
    main() 