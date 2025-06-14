#!/usr/bin/env python3
"""Example usage of QNet state Python bindings."""

import qnet_state
import asyncio

async def main():
    """Demonstrate QNet state management."""
    print("=== QNet State Management Example ===\n")
    
    # Create state database
    print("1. Creating StateDB...")
    db = qnet_state.PyStateDB("example_state", 1000000)
    print("✅ StateDB created\n")
    
    # Check initial balance
    print("2. Checking initial balance...")
    balance = db.get_balance("alice")
    print(f"Alice's balance: {balance} QNC\n")
    
    # Create a transfer transaction
    print("3. Creating transfer transaction...")
    tx = qnet_state.PyTransaction.transfer(
        "alice",  # from
        "bob",    # to
        100,      # amount
        1         # nonce
    )
    print(f"Transaction created:")
    print(f"  - From: {tx.from_address}")
    print(f"  - To: {tx.to_address}")
    print(f"  - Amount: {tx.amount}")
    print(f"  - Type: {tx.tx_type}")
    print(f"  - Hash: {tx.hash()}\n")
    
    # Execute transaction
    print("4. Executing transaction...")
    try:
        tx_hash = db.execute_transaction(tx)
        print(f"✅ Transaction executed: {tx_hash}\n")
    except Exception as e:
        print(f"❌ Transaction failed: {e}\n")
    
    # Check balance after transaction
    print("5. Checking balances after transaction...")
    alice_balance = db.get_balance("alice")
    bob_balance = db.get_balance("bob")
    print(f"Alice's balance: {alice_balance} QNC")
    print(f"Bob's balance: {bob_balance} QNC\n")
    
    # Create a block
    print("6. Creating a block...")
    block = qnet_state.PyBlock(
        height=1,
        previous_hash="0x0000000000000000",
        transactions=[tx],
        validator="validator1"
    )
    print(f"Block created:")
    print(f"  - Height: {block.height}")
    print(f"  - Previous hash: {block.previous_hash}")
    print(f"  - Validator: {block.validator}")
    print(f"  - Transactions: {len(block.transactions)}")
    print(f"  - Hash: {block.hash()}\n")
    
    # Process block
    print("7. Processing block...")
    try:
        db.process_block(block)
        print("✅ Block processed\n")
    except Exception as e:
        print(f"❌ Block processing failed: {e}\n")
    
    # Get latest block
    print("8. Getting latest block...")
    latest = db.get_latest_block()
    if latest:
        print(f"Latest block height: {latest.height}")
    else:
        print("No blocks found\n")
    
    # Node activation example
    print("9. Creating node activation transaction...")
    node_tx = qnet_state.PyTransaction.node_activation(
        "charlie",  # from
        "light",    # node_type
        1000,       # amount (burn)
        1           # nonce
    )
    print(f"Node activation transaction:")
    print(f"  - From: {node_tx.from_address}")
    print(f"  - Node type: light")
    print(f"  - Burn amount: {node_tx.amount}")
    print(f"  - Type: {node_tx.tx_type}\n")
    
    print("=== Example completed ===")

if __name__ == "__main__":
    # Note: The current implementation doesn't require asyncio,
    # but keeping it for future compatibility
    asyncio.run(main()) 