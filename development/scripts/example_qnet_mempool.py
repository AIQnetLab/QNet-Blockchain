#!/usr/bin/env python3
"""
Example usage of QNet mempool Python bindings
"""

import json
import time
from qnet_mempool import Mempool, MempoolConfig

def main():
    print("=== QNet Mempool Python Bindings Example ===\n")
    
    # Create mempool configuration
    config = MempoolConfig(
        max_size=10000,
        min_gas_price=1
    )
    print("Created mempool config")
    
    # Create mempool instance
    mempool = Mempool(config, "./test_state.db")
    print("Created mempool instance\n")
    
    # Example transactions
    transactions = [
        {
            "from": "alice",
            "to": "bob",
            "amount": 100,
            "nonce": 1,
            "timestamp": int(time.time()),
            "gas_price": 10,
            "gas_limit": 10000  # QNet TRANSFER gas limit
        },
        {
            "from": "bob",
            "to": "charlie",
            "amount": 50,
            "nonce": 1,
            "timestamp": int(time.time()),
            "gas_price": 15,
            "gas_limit": 10000  # QNet TRANSFER gas limit
        },
        {
            "from": "charlie",
            "to": "alice",
            "amount": 25,
            "nonce": 1,
            "timestamp": int(time.time()),
            "gas_price": 5,
            "gas_limit": 10000  # QNet TRANSFER gas limit
        }
    ]
    
    # Add transactions to mempool
    print("Adding transactions to mempool:")
    tx_hashes = []
    for i, tx in enumerate(transactions):
        tx_json = json.dumps(tx)
        
        # Validate transaction
        is_valid = mempool.validate(tx_json)
        print(f"  Transaction {i+1} validation: {'VALID' if is_valid else 'INVALID'}")
        
        if is_valid:
            # Add to mempool
            tx_hash = mempool.add_transaction(tx_json)
            tx_hashes.append(tx_hash)
            print(f"  Added transaction {i+1}: hash={tx_hash[:16]}...")
    
    print(f"\nMempool size: {mempool.size()} transactions")
    
    # Get pending transactions
    print("\nPending transactions (limit=2):")
    pending = mempool.get_pending_transactions(2)
    for i, tx_json in enumerate(pending):
        tx = json.loads(tx_json)
        print(f"  {i+1}. {tx}")
    
    # Get specific transaction
    if tx_hashes:
        print(f"\nRetrieving transaction with hash {tx_hashes[0][:16]}...")
        tx_json = mempool.get_transaction(tx_hashes[0])
        if tx_json:
            print(f"  Found: {tx_json}")
        else:
            print("  Not found")
    
    # Remove transaction
    if len(tx_hashes) > 1:
        print(f"\nRemoving transaction with hash {tx_hashes[1][:16]}...")
        removed = mempool.remove_transaction(tx_hashes[1])
        print(f"  Removed: {removed}")
        print(f"  New mempool size: {mempool.size()}")
    
    # Clear mempool
    print("\nClearing mempool...")
    mempool.clear()
    print(f"  Mempool size after clear: {mempool.size()}")
    
    print("\n=== Example completed successfully! ===")

if __name__ == "__main__":
    main() 