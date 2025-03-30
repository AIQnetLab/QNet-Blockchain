#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: storage.py
Contains optimized StorageManager for efficient blockchain data storage.
"""

import os
import json
import logging
import time
import hashlib
import threading
import rocksdb
from blockchain import Block

class StorageManager:
    def __init__(self, data_dir="blockchain_data", use_compression=True):
        self.data_dir = data_dir
        self.use_compression = use_compression
        self.lock = threading.Lock()
        
        # Create directories if they don't exist
        os.makedirs(data_dir, exist_ok=True)
        
        # Initialize RocksDB for different data types
        self.blocks_db = self._init_db(os.path.join(data_dir, "blocks"))
        self.state_db = self._init_db(os.path.join(data_dir, "state"))
        self.meta_db = self._init_db(os.path.join(data_dir, "meta"))
        self.tx_db = self._init_db(os.path.join(data_dir, "transactions"))
        
        logging.info(f"StorageManager initialized in {data_dir}")
    
    def _init_db(self, db_path):
        """Initialize RocksDB with optimal settings"""
        opts = rocksdb.Options()
        opts.create_if_missing = True
        opts.max_open_files = 300
        opts.write_buffer_size = 67108864  # 64MB
        opts.max_write_buffer_number = 3
        opts.target_file_size_base = 67108864  # 64MB
        
        # Optimization for SSD or HDD
        if os.environ.get("QNET_SSD_STORAGE", "true").lower() == "true":
            opts.level0_file_num_compaction_trigger = 8
            opts.level0_slowdown_writes_trigger = 17
            opts.level0_stop_writes_trigger = 24
            opts.max_bytes_for_level_base = 536870912  # 512MB
            opts.max_bytes_for_level_multiplier = 8
            opts.compression = rocksdb.CompressionType.lz4_compression if self.use_compression else rocksdb.CompressionType.no_compression
        else:
            # Optimization for HDD
            opts.level0_file_num_compaction_trigger = 4
            opts.level0_slowdown_writes_trigger = 8
            opts.level0_stop_writes_trigger = 12
            opts.max_bytes_for_level_base = 268435456  # 256MB
            opts.max_bytes_for_level_multiplier = 4
            opts.compression = rocksdb.CompressionType.zstd_compression if self.use_compression else rocksdb.CompressionType.no_compression
        
        return rocksdb.DB(db_path, opts)
    
    def save_block(self, block):
        """Save block to database"""
        with self.lock:
            # Serialize block
            block_dict = block.to_dict()
            block_data = json.dumps(block_dict).encode()
            
            # Create keys for indexing
            height_key = f"block:height:{block.index}".encode()
            hash_key = f"block:hash:{block.hash}".encode()
            
            # Begin write transaction
            batch = rocksdb.WriteBatch()
            
            # Add block record
            batch.put(height_key, block_data)
            batch.put(hash_key, height_key)
            
            # Update metadata
            batch.put(b"latest_height", str(block.index).encode())
            
            # Index transactions in the block
            for tx_idx, tx in enumerate(block.transactions):
                # Generate transaction hash
                tx_json = json.dumps(tx, sort_keys=True).encode()
                tx_hash = hashlib.sha256(tx_json).hexdigest()
                
                # Transaction keys
                tx_key = f"tx:{tx_hash}".encode()
                tx_loc = f"{block.index}:{tx_idx}".encode()
                
                batch.put(tx_key, tx_loc)
                
                # Index addresses
                if 'sender' in tx:
                    addr_key = f"addr:{tx['sender']}:tx:{tx_hash}".encode()
                    batch.put(addr_key, tx_json)
                
                if 'recipient' in tx:
                    addr_key = f"addr:{tx['recipient']}:tx:{tx_hash}".encode()
                    batch.put(addr_key, tx_json)
            
            # Commit all changes
            self.blocks_db.write(batch)
            
            logging.info(f"Block {block.index} saved to storage")
            return True
    
    def get_block(self, height=None, block_hash=None):
        """Get block by height or hash"""
        try:
            if height is not None:
                # Get directly by height
                height_key = f"block:height:{height}".encode()
                block_data = self.blocks_db.get(height_key)
            elif block_hash is not None:
                # Get by hash (which points to height)
                hash_key = f"block:hash:{block_hash}".encode()
                height_key = self.blocks_db.get(hash_key)
                if height_key:
                    block_data = self.blocks_db.get(height_key)
                else:
                    return None
            else:
                return None
                
            if block_data:
                block_dict = json.loads(block_data)
                return Block.from_dict(block_dict)
            return None
        except Exception as e:
            logging.error(f"Error getting block: {e}")
            return None
    
    def get_blockchain_height(self):
        """Returns the current blockchain height"""
        try:
            height_data = self.meta_db.get(b"latest_height")
            return int(height_data.decode()) if height_data else -1
        except Exception as e:
            logging.error(f"Error getting blockchain height: {e}")
            return -1
    
    def get_blocks_range(self, start_height, end_height):
        """Gets a range of blocks from start_height to end_height inclusive"""
        blocks = []
        for height in range(start_height, end_height + 1):
            block = self.get_block(height=height)
            if block:
                blocks.append(block)
        return blocks
    
    def update_account_balance(self, address, balance):
        """Updates account balance in state"""
        key = f"balance:{address}".encode()
        self.state_db.put(key, str(balance).encode())
    
    def get_account_balance(self, address):
        """Gets account balance from state"""
        key = f"balance:{address}".encode()
        balance_data = self.state_db.get(key)
        return float(balance_data.decode()) if balance_data else 0
    
    def save_total_issued(self, total):
        """Saves total amount of issued coins"""
        self.meta_db.put(b"total_issued", str(total).encode())
    
    def get_total_issued(self):
        """Gets total amount of issued coins"""
        total_issued_data = self.meta_db.get(b"total_issued")
        return float(total_issued_data.decode()) if total_issued_data else 0
    
    def compute_state_from_blocks(self):
        """Computes state (balances) from all blocks"""
        state = {}
        total_issued = 0
        
        height = self.get_blockchain_height()
        
        # If blockchain is empty, return empty state
        if height < 0:
            return {}, 0
        
        # Start from the very first block (genesis)
        for block_height in range(0, height + 1):
            block = self.get_block(height=block_height)
            if not block:
                continue
                
            for tx in block.transactions:
                if tx.get("sender") == "network":
                    # This is a coinbase transaction
                    recipient = tx.get("recipient")
                    amount = tx.get("amount", 0)
                    total_issued += amount
                    state[recipient] = state.get(recipient, 0) + amount
                else:
                    # Regular transaction
                    sender = tx.get("sender")
                    recipient = tx.get("recipient")
                    amount = tx.get("amount", 0)
                    
                    state[sender] = state.get(sender, 0) - amount
                    state[recipient] = state.get(recipient, 0) + amount
        
        return state, total_issued
    
    def create_snapshot(self, output_path):
        """Creates a snapshot of blockchain state for fast synchronization"""
        try:
            # Get current height and state
            height = self.get_blockchain_height()
            state, total_issued = self.compute_state_from_blocks()
            
            # Create snapshot structure
            snapshot = {
                "height": height,
                "timestamp": time.time(),
                "total_issued": total_issued,
                "state": state,
                "latest_block_hash": self.get_block(height=height).hash if height >= 0 else None
            }
            
            # Save snapshot to file
            with open(output_path, 'w') as f:
                json.dump(snapshot, f)
                
            logging.info(f"Created blockchain snapshot at height {height}")
            return True
        except Exception as e:
            logging.error(f"Error creating snapshot: {e}")
            return False
    
    def load_snapshot(self, snapshot_path):
        """Loads state from a snapshot"""
        try:
            with open(snapshot_path, 'r') as f:
                snapshot = json.load(f)
                
            height = snapshot.get("height")
            state = snapshot.get("state")
            total_issued = snapshot.get("total_issued")
            
            # Verify snapshot validity
            if height is None or state is None or total_issued is None:
                logging.error("Invalid snapshot format")
                return False
                
            # Update metadata
            self.meta_db.put(b"latest_height", str(height).encode())
            self.save_total_issued(total_issued)
            
            # Update state
            batch = rocksdb.WriteBatch()
            for address, balance in state.items():
                key = f"balance:{address}".encode()
                batch.put(key, str(balance).encode())
            
            self.state_db.write(batch)
            
            logging.info(f"Loaded blockchain snapshot at height {height}")
            return True
        except Exception as e:
            logging.error(f"Error loading snapshot: {e}")
            return False