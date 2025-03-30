#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: test_blockchain.py
Unit tests for the blockchain module.
"""

import unittest
import time
import os
import tempfile
import shutil
import sys
import hashlib
import json
from threading import Thread

# Add parent directory to path to import modules
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    from blockchain import Block, Blockchain
    from block_rewards import calculate_block_reward
    from memory_storage import StorageManager
except ImportError as e:
    print(f"Import error: {e}")
    sys.exit(1)

def dummy_sign_function(block_hash):
    """Dummy function to sign blocks during tests"""
    return hashlib.sha256(block_hash.encode()).hexdigest()

class TestBlock(unittest.TestCase):
    def test_block_creation(self):
        """Test basic block creation and hash computation"""
        block = Block(1, time.time(), [], "previous_hash", 0)
        self.assertEqual(block.index, 1)
        self.assertEqual(block.previous_hash, "previous_hash")
        self.assertIsNotNone(block.hash)
        
    def test_block_hash(self):
        """Test that blocks with same data have same hash"""
        timestamp = 1614556800  # Fixed timestamp for reproducibility
        block1 = Block(1, timestamp, [], "previous_hash", 0)
        block2 = Block(1, timestamp, [], "previous_hash", 0)
        self.assertEqual(block1.hash, block2.hash)
        
    def test_block_different_hash(self):
        """Test that blocks with different data have different hashes"""
        timestamp = 1614556800  # Fixed timestamp for reproducibility
        block1 = Block(1, timestamp, [], "previous_hash", 0)
        block2 = Block(1, timestamp, [{"test": "transaction"}], "previous_hash", 0)
        self.assertNotEqual(block1.hash, block2.hash)
        
    def test_block_serialization(self):
        """Test block serialization to dict and back"""
        block = Block(1, time.time(), [{"test": "tx"}], "previous_hash", 42)
        block.signature = "signature"
        block.producer = "producer"
        block.pub_key = "pub_key"
        
        # Serialize to dict
        block_dict = block.to_dict()
        
        # Deserialize back to Block
        block2 = Block.from_dict(block_dict)
        
        # Check values
        self.assertEqual(block.index, block2.index)
        self.assertEqual(block.timestamp, block2.timestamp)
        self.assertEqual(block.transactions, block2.transactions)
        self.assertEqual(block.previous_hash, block2.previous_hash)
        self.assertEqual(block.hash, block2.hash)
        self.assertEqual(block.nonce, block2.nonce)
        self.assertEqual(block.signature, block2.signature)
        self.assertEqual(block.producer, block2.producer)
        self.assertEqual(block.pub_key, block2.pub_key)

class TestBlockchain(unittest.TestCase):
    def setUp(self):
        """Set up a fresh blockchain for each test"""
        # Use in-memory blockchain for tests
        self.blockchain = Blockchain(storage_manager=None)
        
    def test_genesis_block(self):
        """Test that blockchain starts with a genesis block"""
        self.assertEqual(len(self.blockchain.chain), 1)
        self.assertEqual(self.blockchain.chain[0].index, 0)
        self.assertEqual(self.blockchain.chain[0].previous_hash, "0")
        
    def test_add_block(self):
        """Test adding a block to the blockchain"""
        coinbase_tx = {
            "sender": "network",
            "recipient": "miner",
            "amount": 50,
            "pub_key": "pub_key"
        }
        
        # Add a block
        block = self.blockchain.mine_block(coinbase_tx, dummy_sign_function)
        
        self.assertEqual(len(self.blockchain.chain), 2)
        self.assertEqual(block.index, 1)
        self.assertEqual(block.previous_hash, self.blockchain.chain[0].hash)
        
    def test_blockchain_validation(self):
        """Test transaction validation"""
        # Add funds to an account
        coinbase_tx = {
            "sender": "network",
            "recipient": "alice",
            "amount": 100,
            "pub_key": "pub_key"
        }
        self.blockchain.mine_block(coinbase_tx, dummy_sign_function)
        
        # Valid transaction
        valid_tx = {
            "sender": "alice",
            "recipient": "bob",
            "amount": 50
        }
        self.assertTrue(self.blockchain.validate_transaction(valid_tx))
        
        # Invalid transaction (insufficient funds)
        invalid_tx = {
            "sender": "alice",
            "recipient": "bob",
            "amount": 200
        }
        self.assertFalse(self.blockchain.validate_transaction(invalid_tx))
        
    def test_blockchain_state(self):
        """Test state calculation after adding blocks"""
        # Add funds to alice
        coinbase_tx1 = {
            "sender": "network",
            "recipient": "alice",
            "amount": 100,
            "pub_key": "pub_key"
        }
        self.blockchain.mine_block(coinbase_tx1, dummy_sign_function)
        
        # Add transaction and more funds
        self.blockchain.add_transaction({
            "sender": "alice",
            "recipient": "bob",
            "amount": 30
        })
        
        coinbase_tx2 = {
            "sender": "network",
            "recipient": "miner",
            "amount": 50,
            "pub_key": "pub_key"
        }
        self.blockchain.mine_block(coinbase_tx2, dummy_sign_function)
        
        # Check state
        state, total_issued = self.blockchain.compute_state()
        self.assertEqual(state["alice"], 70)  # 100 - 30
        self.assertEqual(state["bob"], 30)
        self.assertEqual(state["miner"], 50)
        self.assertEqual(total_issued, 150)  # 100 + 50
        
    def test_block_reward(self):
        """Test that block rewards follow the emission schedule"""
        # Test first blocks
        reward0 = calculate_block_reward(0)
        self.assertEqual(reward0, 16384)  # Initial reward (2^14)
        
        # Test later blocks
        reward1000 = calculate_block_reward(1000)
        self.assertLess(reward1000, 16384)  # Should be less than initial
        self.assertGreater(reward1000, 32)  # But greater than minimum

class TestMemoryStorage(unittest.TestCase):
    def setUp(self):
        """Set up a storage manager for each test"""
        self.storage = StorageManager()
        
    def test_storage_basics(self):
        """Test basic storage operations"""
        # Create a test block
        block = Block(1, time.time(), [{"test": "tx"}], "previous_hash", 42)
        
        # Save block
        result = self.storage.save_block(block)
        self.assertTrue(result)
        
        # Get block by height
        retrieved = self.storage.get_block(height=1)
        self.assertIsNotNone(retrieved)
        self.assertEqual(retrieved.index, 1)
        
        # Get block by hash
        retrieved2 = self.storage.get_block(block_hash=block.hash)
        self.assertIsNotNone(retrieved2)
        self.assertEqual(retrieved2.hash, block.hash)
        
    def test_account_balances(self):
        """Test account balance operations"""
        # Set balance
        self.storage.update_account_balance("alice", 100)
        
        # Get balance
        balance = self.storage.get_account_balance("alice")
        self.assertEqual(balance, 100)
        
        # Get non-existent balance
        balance2 = self.storage.get_account_balance("bob")
        self.assertEqual(balance2, 0)  # Should return 0 for non-existent accounts
        
    def test_compute_state(self):
        """Test state computation from blocks"""
        # Create blocks with transactions
        block1 = Block(1, time.time(), [
            {"sender": "network", "recipient": "alice", "amount": 100}
        ], "previous_hash", 0)
        
        block2 = Block(2, time.time(), [
            {"sender": "alice", "recipient": "bob", "amount": 30}
        ], block1.hash, 0)
        
        # Save blocks
        self.storage.save_block(block1)
        self.storage.save_block(block2)
        
        # Compute state
        state, total = self.storage.compute_state_from_blocks()
        
        # Check state
        self.assertEqual(state["alice"], 70)  # 100 - 30
        self.assertEqual(state["bob"], 30)
        self.assertEqual(total, 100)  # Total issued

class TestConcurrent(unittest.TestCase):
    def test_concurrent_transactions(self):
        """Test blockchain with concurrent transactions"""
        blockchain = Blockchain(storage_manager=None)
        
        # Add initial funds
        coinbase_tx = {
            "sender": "network",
            "recipient": "alice",
            "amount": 1000,
            "pub_key": "pub_key"
        }
        blockchain.mine_block(coinbase_tx, dummy_sign_function)
        
        # Define a function for concurrent transaction adding
        def add_transactions(sender, recipient, amount, count):
            for i in range(count):
                tx = {
                    "sender": sender,
                    "recipient": recipient,
                    "amount": amount,
                }
                blockchain.add_transaction(tx)
                time.sleep(0.01)  # Small delay
        
        # Start multiple threads adding transactions
        threads = []
        for i in range(5):
            t = Thread(target=add_transactions, args=("alice", f"recipient{i}", 10, 10))
            threads.append(t)
            t.start()
        
        # Wait for all threads to complete
        for t in threads:
            t.join()
        
        # Mine a block to include the transactions
        blockchain.mine_block({
            "sender": "network",
            "recipient": "miner",
            "amount": 50,
            "pub_key": "pub_key"
        }, dummy_sign_function)
        
        # Check state
        state, _ = blockchain.compute_state()
        
        # Alice should have 1000 - (5 recipients * 10 transactions * 10 value) = 500
        self.assertEqual(state["alice"], 1000 - 5*10*10)
        
        # Each recipient should have received 10 * 10 = 100
        for i in range(5):
            self.assertEqual(state[f"recipient{i}"], 100)

if __name__ == "__main__":
    unittest.main()