#!/usr/bin/env python3
"""
Direct mempool benchmark to test raw performance
"""

import time
import sys
import os

# Add the Python bindings to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'target', 'release'))

try:
    import qnet_mempool
    print("✅ Successfully imported qnet_mempool")
except ImportError as e:
    print(f"❌ Failed to import qnet_mempool: {e}")
    print("Make sure to build with: cargo build --release --features python")
    sys.exit(1)

def benchmark_mempool():
    """Benchmark raw mempool performance"""
    print("\n🚀 Starting Direct Mempool Benchmark")
    print("-" * 60)
    
    # Create mempool with simple configuration
    config = {
        "max_size": 100000,
        "max_per_account": 10000,
        "min_gas_price": 1,
    }
    
    mempool = qnet_mempool.SimpleMempool(
        max_size=config["max_size"],
        max_per_account=config["max_per_account"],
        min_gas_price=config["min_gas_price"]
    )
    
    print(f"Created mempool with capacity: {config['max_size']}")
    
    # Test different batch sizes
    batch_sizes = [100, 1000, 10000]
    
    for batch_size in batch_sizes:
        print(f"\n📦 Testing batch size: {batch_size}")
        
        # Generate test transactions
        start_gen = time.time()
        transactions = []
        for i in range(batch_size):
            tx_json = f'{{"from":"addr{i}","to":"addr{i+1}","amount":{i},"nonce":{i}}}'
            tx_hash = f"hash_{i:08x}"
            transactions.append((tx_json, tx_hash))
        gen_time = time.time() - start_gen
        print(f"  Generated {batch_size} transactions in {gen_time:.3f}s")
        
        # Add transactions to mempool
        start_add = time.time()
        for tx_json, tx_hash in transactions:
            mempool.add_raw_transaction(tx_json, tx_hash)
        add_time = time.time() - start_add
        
        tps = batch_size / add_time
        print(f"  Added {batch_size} transactions in {add_time:.3f}s")
        print(f"  ⚡ Performance: {tps:.0f} TPS")
        
        # Test retrieval
        start_get = time.time()
        pending = mempool.get_pending_transactions(min(100, batch_size))
        get_time = time.time() - start_get
        print(f"  Retrieved {len(pending)} transactions in {get_time:.3f}s")
        
        # Clear for next test
        mempool.clear()
    
    # Ultimate stress test
    print(f"\n🔥 ULTIMATE STRESS TEST")
    print("-" * 40)
    
    target_tx = 100000
    print(f"Target: {target_tx} transactions")
    
    # Pre-generate all transactions
    print("Pre-generating transactions...")
    start_gen = time.time()
    all_transactions = []
    for i in range(target_tx):
        tx_json = f'{{"from":"stress{i}","to":"stress{i+1}","amount":{i%1000},"nonce":{i}}}'
        tx_hash = f"stress_{i:08x}"
        all_transactions.append((tx_json, tx_hash))
    gen_time = time.time() - start_gen
    print(f"Generated {target_tx} transactions in {gen_time:.3f}s")
    
    # Add all transactions
    print("\nAdding to mempool...")
    start_add = time.time()
    added = 0
    
    for tx_json, tx_hash in all_transactions:
        try:
            mempool.add_raw_transaction(tx_json, tx_hash)
            added += 1
            
            # Progress update every 10k
            if added % 10000 == 0:
                elapsed = time.time() - start_add
                current_tps = added / elapsed
                print(f"  Progress: {added}/{target_tx} | TPS: {current_tps:.0f}")
        except Exception as e:
            print(f"  Error at {added}: {e}")
            break
    
    total_time = time.time() - start_add
    final_tps = added / total_time
    
    print(f"\n📊 FINAL RESULTS:")
    print(f"  Total transactions: {added}")
    print(f"  Total time: {total_time:.3f}s")
    print(f"  Average TPS: {final_tps:.0f}")
    
    if final_tps >= 10000:
        print(f"\n✅ SUCCESS! Achieved {final_tps:.0f} TPS (Target: 10,000 TPS)")
    else:
        print(f"\n❌ FAILED! Only achieved {final_tps:.0f} TPS (Target: 10,000 TPS)")
        print(f"   Need {(10000/final_tps):.1f}x improvement")

if __name__ == "__main__":
    benchmark_mempool() 