#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: blockchain.py
Contains the Block and Blockchain classes for the QNet network with improved security.
"""

import time
import json
import hashlib
import logging
from threading import Lock
from crypto_bindings import compute_merkle_root, verify_signature

# Import enhanced transaction validation
from transaction_validation import (
    validate_transaction, 
    validate_block_transactions, 
    TransactionPool,
    compute_transaction_hash
)

# Import validation decorators
from validation_decorators import validate_parameters, handle_exceptions

lock = Lock()

class Block:
    def __init__(self, index, timestamp, transactions, previous_hash, nonce=0):
        self.index = index
        self.timestamp = timestamp
        self.transactions = transactions
        self.previous_hash = previous_hash
        self.nonce = nonce
        self.hash = self.compute_hash()
        self.signature = None
        self.producer = None
        self.pub_key = None
        self.merkle_root = None
    
    def compute_hash(self):
        """Compute the hash of the block"""
        data = {
            "index": self.index,
            "timestamp": self.timestamp,
            "transactions": self.transactions,
            "previous_hash": self.previous_hash,
            "nonce": self.nonce
        }
        # Use a secure hashing algorithm (SHA-256)
        return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()
    
    def compute_merkle_root(self):
        """Compute the Merkle root of the transactions"""
        if not self.transactions:
            return hashlib.sha256(b"").hexdigest()
        
        # Compute transaction hashes
        tx_hashes = []
        for tx in self.transactions:
            tx_hash = compute_transaction_hash(tx)
            tx_hashes.append(tx_hash)
        
        # Use the crypto_bindings implementation for efficiency
        return compute_merkle_root(tx_hashes)
    
    def verify_block_signature(self):
        """Verify block signature with producer's public key"""
        if not self.signature or not self.producer or not self.pub_key:
            return False
            
        try:
            # Message to verify is the block hash
            return verify_signature(self.hash, self.signature, self.pub_key)
        except Exception as e:
            logging.error(f"Error verifying block signature: {e}")
            return False
    
    def __str__(self):
        return f"Block(index={self.index}, hash={self.hash[:8]}..., tx_count={len(self.transactions)})"
    
    def to_dict(self):
        """Convert block to dictionary for serialization"""
        # Compute Merkle root if not already computed
        if not self.merkle_root and self.transactions:
            self.merkle_root = self.compute_merkle_root()
            
        return {
            "index": self.index,
            "timestamp": self.timestamp,
            "transactions": self.transactions,
            "previous_hash": self.previous_hash,
            "hash": self.hash,
            "nonce": self.nonce,
            "signature": self.signature,
            "producer": self.producer,
            "pub_key": self.pub_key,
            "merkle_root": self.merkle_root
        }
    
    @staticmethod
    def from_dict(block_dict):
        """Create a Block object from a dictionary"""
        block = Block(
            block_dict["index"],
            block_dict["timestamp"],
            block_dict["transactions"],
            block_dict["previous_hash"],
            block_dict["nonce"]
        )
        block.hash = block_dict["hash"]
        block.signature = block_dict.get("signature")
        block.producer = block_dict.get("producer")
        block.pub_key = block_dict.get("pub_key")
        block.merkle_root = block_dict.get("merkle_root")
        return block

class Blockchain:
    def __init__(self, storage_manager=None):
        """
        Initialize the blockchain.
        
        Args:
            storage_manager: Storage manager for persistent data
        """
        # Initialize in-memory state
        self.transaction_pool = TransactionPool(max_pool_size=5000)
        self.state = {}         # Incrementally updated state (balances)
        self.total_issued = 0   # Incrementally updated total issued coins
        
        # Chain is used to represent blockchain height and the in-memory blocks
        self.chain = []
        
        # Initialize storage manager
        self.storage_manager = storage_manager
        
        # Maximum transaction size limit in bytes
        self.max_transaction_size = 100 * 1024  # 100 KB
        
        # Maximum number of transactions in a block
        self.max_transactions_per_block = 1000
        
        # Create genesis block if chain is empty
        self.create_genesis_block()

    @handle_exceptions(log_level=logging.ERROR)
    def create_genesis_block(self):
        """Create the genesis block if not already present"""
        with lock:
            if self.storage_manager:
                # Check if genesis block exists in storage
                genesis = self.storage_manager.get_block(height=0)
                if not genesis:
                    genesis = Block(0, time.time(), [], "0", nonce=0)
                    # Save to storage
                    self.storage_manager.save_block(genesis)
                    logging.info("Created and stored genesis block")
                else:
                    logging.info("Loaded genesis block from storage")
                
                # Add to in-memory chain
                self.chain = [genesis]
                
                # Update state
                self.update_state(genesis)
            else:
                # In-memory only mode
                genesis = Block(0, time.time(), [], "0", nonce=0)
                self.chain = [genesis]
                self.update_state(genesis)
                logging.info("Created genesis block (memory-only mode)")

    @property
    def last_block(self):
        """Get the last block in the chain"""
        if not self.chain:
            if self.storage_manager:
                # Try to load from storage
                latest = self.storage_manager.get_latest_block()
                if latest:
                    self.chain = [latest]
                    return latest
            return None
        return self.chain[-1]
    
    @validate_parameters
    def get_block_by_index(self, index: int):
        """Get a block by its index (height)"""
        # First check the in-memory chain
        for block in self.chain:
            if block.index == index:
                return block
            
        # If not in memory and using storage manager, try to load from storage
        if self.storage_manager:
            block = self.storage_manager.get_block(height=index)
            if block:
                return block
        
        # Not found in memory or storage
        return None
    
    @validate_parameters
    def get_block_by_hash(self, block_hash: str):
        """Get a block by its hash"""
        # First check the in-memory chain
        for block in self.chain:
            if block.hash == block_hash:
                return block
                
        # If not in memory and using storage manager, try to load from storage
        if self.storage_manager:
            block = self.storage_manager.get_block(block_hash=block_hash)
            if block:
                return block
        
        # Not found in memory or storage
        return None

    @handle_exceptions(log_level=logging.ERROR, return_value=False)
    def add_transaction(self, tx):
        """Add a transaction to the pending pool with enhanced validation"""
        with lock:
            # Use transaction pool for proper management
            is_valid, reason = self.transaction_pool.add_transaction(tx, self.state)
            
            if is_valid:
                logging.info(f"Transaction added to pool: {compute_transaction_hash(tx)[:8]}...")
                return True
            else:
                logging.warning(f"Transaction rejected: {reason}")
                return False
        
    def update_state(self, block):
        """
        Update state based on block transactions incrementally.
        Also updates persistent storage if enabled.
        """
        updates = {}  # Track which accounts are updated
        
        for tx in block.transactions:
            if tx.get("sender") == "network":
                # Coinbase transaction
                recipient = tx.get("recipient")
                amount = tx.get("amount", 0)
                self.total_issued += amount
                self.state[recipient] = self.state.get(recipient, 0) + amount
                updates[recipient] = self.state[recipient]
            else:
                # Regular transaction
                sender = tx.get("sender")
                recipient = tx.get("recipient")
                amount = tx.get("amount", 0)
                
                # Update sender balance
                sender_balance = self.state.get(sender, 0)
                self.state[sender] = sender_balance - amount
                updates[sender] = self.state[sender]
                
                # Update recipient balance
                self.state[recipient] = self.state.get(recipient, 0) + amount
                updates[recipient] = self.state[recipient]
        
        # Update persistent storage if enabled
        if self.storage_manager:
            for address, balance in updates.items():
                self.storage_manager.update_account_balance(address, balance)
            self.storage_manager.save_total_issued(self.total_issued)

    @handle_exceptions(log_level=logging.ERROR)
    def mine_block(self, coinbase_tx, sign_func, pruned_mode=False, max_chain_length=100):
        """
        Mine a new block with pending transactions and a coinbase reward.
        
        Args:
            coinbase_tx: The coinbase transaction for the block reward
            sign_func: Function to sign the block hash
            pruned_mode: Whether to prune old blocks from memory
            max_chain_length: Maximum number of blocks to keep in memory
            
        Returns:
            The newly mined block
        """
        with lock:
            # Get current round number (blockchain height)
            round_number = len(self.chain)
            
            # Get the previous block's hash
            prev_hash = self.last_block.hash if self.last_block else "0"
            
            # Get transactions from the pool, including the coinbase transaction
            # Use TransactionPool's get_transactions method to get valid transactions
            valid_txs = [coinbase_tx]  # Start with coinbase
            
            # Validate coinbase transaction
            is_valid, reason = validate_transaction(coinbase_tx)
            if not is_valid:
                logging.error(f"Invalid coinbase transaction: {reason}")
                return None
                
            # Get other transactions from the pool (up to max_transactions_per_block-1)
            remaining_slots = self.max_transactions_per_block - 1
            pool_txs = self.transaction_pool.get_transactions(limit=remaining_slots)
            
            # Validate each transaction against current state
            state_copy = self.state.copy()
            for tx in pool_txs:
                is_valid, reason = validate_transaction(tx, state_copy)
                if is_valid:
                    valid_txs.append(tx)
                    
                    # Update state copy to reflect this transaction
                    sender = tx.get("sender")
                    recipient = tx.get("recipient")
                    amount = float(tx.get("amount", 0))
                    
                    if sender != "network":  # Skip sender update for coinbase
                        state_copy[sender] = state_copy.get(sender, 0) - amount
                    
                    # Update recipient
                    state_copy[recipient] = state_copy.get(recipient, 0) + amount
                else:
                    logging.warning(f"Skipping invalid transaction during mining: {reason}")
            
            # If no transactions (except coinbase), skip block creation
            if len(valid_txs) <= 1:
                logging.info("No valid transactions to mine (other than coinbase)")
                return None
            
            # Create and sign the new block
            block = Block(round_number, time.time(), valid_txs, prev_hash, nonce=0)
            block.hash = block.compute_hash()
            block.signature = sign_func(block.hash)
            block.producer = coinbase_tx.get("recipient")
            block.pub_key = coinbase_tx.get("pub_key")
            
            # Compute Merkle root
            block.merkle_root = block.compute_merkle_root()
            
            # Verify block before adding it
            if not block.verify_block_signature():
                logging.error("Block signature verification failed")
                return None
            
            # If using storage manager, save the block
            if self.storage_manager:
                success = self.storage_manager.save_block(block)
                if not success:
                    logging.error(f"Failed to save block {block.index} to storage")
                    return None
            
            # Add to in-memory chain
            self.chain.append(block)
            
            # Remove transactions from pool that were included in the block
            self.transaction_pool.remove_confirmed_transactions(valid_txs)
            
            # Update state
            self.update_state(block)
            
            # Prune old blocks if necessary
            if pruned_mode and len(self.chain) > max_chain_length:
                # Archive old blocks before pruning them
                if self.storage_manager:
                    old_blocks = self.chain[:-max_chain_length]
                    self.storage_manager.archive_blocks(old_blocks)
                    
                # Remove old blocks from memory
                self.chain = self.chain[-max_chain_length:]
                
                logging.info(f"Pruned old blocks from memory. In-memory chain length is now {len(self.chain)}")
                
            return block

    def recalc_state(self):
        """
        Recalculate state from scratch based on the current chain.
        For persistent storage, uses the database to compute state.
        """
        if self.storage_manager:
            # Use storage to compute state from all blocks
            self.state, self.total_issued = self.storage_manager.compute_state_from_blocks()
            return
        
        # In-memory calculation
        self.state = {}
        self.total_issued = 0
        
        # Process transactions from all blocks
        for block in self.chain:
            for tx in block.transactions:
                if tx.get("sender") == "network":
                    recipient = tx.get("recipient")
                    amount = tx.get("amount", 0)
                    self.total_issued += amount
                    self.state[recipient] = self.state.get(recipient, 0) + amount
                else:
                    sender = tx.get("sender")
                    recipient = tx.get("recipient")
                    amount = tx.get("amount", 0)
                    self.state[sender] = self.state.get(sender, 0) - amount
                    self.state[recipient] = self.state.get(recipient, 0) + amount

    def compute_state(self):
        """
        Returns the current state (balances) and total issued coins.
        With storage manager, ensures the in-memory state matches the database.
        """
        if self.storage_manager:
            # Check if we need to sync state with storage
            db_height = self.storage_manager.get_blockchain_height()
            memory_height = len(self.chain) - 1 if self.chain else -1
            
            if db_height > memory_height:
                logging.info(f"State out of sync (DB: {db_height}, Memory: {memory_height}). Recalculating...")
                self.recalc_state()
        
        return self.state, self.total_issued
    
    @handle_exceptions(log_level=logging.ERROR)
    def verify_chain(self, start_index=0, end_index=None):
        """
        Verify the integrity of the blockchain
        
        Args:
            start_index: Index to start verification from (default: 0)
            end_index: Index to end verification at (default: None, verify all)
            
        Returns:
            (bool, str): (success, error_message)
        """
        # Determine the range to verify
        if end_index is None:
            end_index = len(self.chain) - 1
            
        if start_index < 0 or end_index >= len(self.chain) or start_index > end_index:
            return False, "Invalid range"
            
        # Verify each block in the range
        for i in range(start_index, end_index + 1):
            block = self.chain[i]
            
            # Skip genesis block
            if i == 0:
                continue
                
            # Verify previous hash
            prev_block = self.chain[i-1]
            if block.previous_hash != prev_block.hash:
                return False, f"Block {i} has invalid previous hash"
                
            # Verify block hash
            computed_hash = block.compute_hash()
            if block.hash != computed_hash:
                return False, f"Block {i} has invalid hash"
                
            # Verify Merkle root if present
            if block.merkle_root:
                computed_root = block.compute_merkle_root()
                if block.merkle_root != computed_root:
                    return False, f"Block {i} has invalid Merkle root"
                    
            # Verify block signature if present
            if block.signature and block.pub_key:
                if not block.verify_block_signature():
                    return False, f"Block {i} has invalid signature"
                    
            # Verify all transactions in the block
            state_copy = {}  # Temporary state for validation
            is_valid, reason = validate_block_transactions(block.transactions, state_copy)
            if not is_valid:
                return False, f"Block {i} contains invalid transactions: {reason}"
                    
        return True, "Chain verification successful"