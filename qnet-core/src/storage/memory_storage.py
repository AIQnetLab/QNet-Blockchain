#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: memory_storage.py
In-memory storage implementation for QNet blockchain with optimized performance.
"""

import os
import json
import logging
import time
import hashlib
import threading
import pickle
import gzip
import heapq
from collections import defaultdict, OrderedDict
import tempfile

# Optimized in-memory database to mimic RocksDB interface
class InMemoryDB:
    def __init__(self, max_memory_mb=500):
        """
        Initialize in-memory database with memory management
        
        Args:
            max_memory_mb: Maximum memory usage in MB before using disk
        """
        self.data = {}
        self.lock = threading.Lock()
        self.max_memory = max_memory_mb * 1024 * 1024  # Convert to bytes
        self.current_memory = 0
        self.access_count = {}  # Track key access frequency
        self.last_access = {}   # Track last access time
        self.overflow_dir = os.path.join(tempfile.gettempdir(), "qnet_overflow")
        os.makedirs(self.overflow_dir, exist_ok=True)
        
        # Start memory monitoring thread
        self.running = True
        self.monitor_thread = threading.Thread(target=self._monitor_memory, daemon=True)
        self.monitor_thread.start()
        
    def _monitor_memory(self):
        """Background thread to monitor and manage memory usage"""
        while self.running:
            try:
                # Check current memory usage
                self._check_memory()
                
                # Clean up overflow directory
                self._clean_overflow()
            except Exception as e:
                logging.error(f"Error in memory monitor: {e}")
                
            time.sleep(60)  # Check every minute
    
    def _check_memory(self):
        """Check memory usage and evict items if necessary"""
        with self.lock:
            # Recalculate current memory usage
            self.current_memory = sum(len(k) + len(v) if isinstance(v, (str, bytes)) else len(k) + 8192 
                                     for k, v in self.data.items())
            
            # If exceeding memory limit, evict items
            if self.current_memory > self.max_memory:
                logging.info(f"Memory usage {self.current_memory/1024/1024:.2f}MB exceeds limit, evicting items")
                self._evict_items()
    
    def _evict_items(self, target_percent=0.7):
        """
        Evict least recently/frequently used items to disk
        
        Args:
            target_percent: Target memory usage as fraction of max (0.7 = 70%)
        """
        target_memory = self.max_memory * target_percent
        
        # Create a list of (key, score) tuples where score is a combination of
        # frequency and recency of access
        now = time.time()
        scores = []
        
        for key in self.data:
            # Score = frequency * recency (higher is better to keep)
            frequency = self.access_count.get(key, 1)
            recency = 1.0 / (now - self.last_access.get(key, now) + 1)
            score = frequency * recency
            
            # Size is used to determine how much memory we free
            size = len(key) + len(self.data[key]) if isinstance(self.data[key], (str, bytes)) else len(key) + 8192
            
            scores.append((key, score, size))
        
        # Sort by score (lowest score first - these will be evicted)
        scores.sort(key=lambda x: x[1])
        
        # Evict items until we reach target memory
        memory_freed = 0
        items_evicted = 0
        
        for key, score, size in scores:
            if self.current_memory - memory_freed <= target_memory:
                break
                
            # Skip small items
            if size < 1024:  # Don't evict items smaller than 1KB
                continue
                
            # Write item to disk
            self._write_to_disk(key, self.data[key])
            
            # Remove from memory
            del self.data[key]
            memory_freed += size
            items_evicted += 1
            
            # Also remove from tracking
            if key in self.access_count:
                del self.access_count[key]
            if key in self.last_access:
                del self.last_access[key]
        
        self.current_memory -= memory_freed
        logging.info(f"Evicted {items_evicted} items, freed {memory_freed/1024/1024:.2f}MB")
    
    def _write_to_disk(self, key, value):
        """Write a key-value pair to disk"""
        key_hash = hashlib.md5(key.encode() if isinstance(key, str) else key).hexdigest()
        file_path = os.path.join(self.overflow_dir, key_hash)
        
        try:
            with gzip.open(file_path, 'wb') as f:
                pickle.dump((key, value), f)
        except Exception as e:
            logging.error(f"Error writing to disk: {e}")
    
    def _read_from_disk(self, key):
        """Read a key-value pair from disk"""
        key_hash = hashlib.md5(key.encode() if isinstance(key, str) else key).hexdigest()
        file_path = os.path.join(self.overflow_dir, key_hash)
        
        if not os.path.exists(file_path):
            return None
            
        try:
            with gzip.open(file_path, 'rb') as f:
                stored_key, value = pickle.load(f)
                # Verify the key matches
                if stored_key == key:
                    return value
        except Exception as e:
            logging.error(f"Error reading from disk: {e}")
            
        return None
    
    def _clean_overflow(self):
        """Clean up old overflow files"""
        try:
            now = time.time()
            for filename in os.listdir(self.overflow_dir):
                file_path = os.path.join(self.overflow_dir, filename)
                
                # Check if file is older than 1 day and not accessed recently
                if os.path.isfile(file_path) and now - os.stat(file_path).st_mtime > 86400:
                    try:
                        os.remove(file_path)
                    except:
                        pass
        except Exception as e:
            logging.debug(f"Error cleaning overflow directory: {e}")
        
    def get(self, key):
        """Get value by key, with automatic disk fallback"""
        if isinstance(key, bytes):
            key = key.decode('utf-8')
        
        with self.lock:
            # Update access metrics
            self.access_count[key] = self.access_count.get(key, 0) + 1
            self.last_access[key] = time.time()
            
            # Check if in memory
            if key in self.data:
                return self.data[key]
            
            # Try to load from disk
            value = self._read_from_disk(key)
            if value is not None:
                # Put back in memory
                self.data[key] = value
                return value
            
            return None
        
    def put(self, key, value):
        """Put key-value pair"""
        with self.lock:
            if isinstance(key, bytes):
                key = key.decode('utf-8')
            if isinstance(value, bytes):
                value = value.decode('utf-8')
            
            # Update access metrics
            self.access_count[key] = self.access_count.get(key, 0) + 1
            self.last_access[key] = time.time()
            
            # Update memory usage estimate
            old_size = 0
            if key in self.data:
                old_value = self.data[key]
                old_size = len(old_value) if isinstance(old_value, (str, bytes)) else 8192
            
            new_size = len(value) if isinstance(value, (str, bytes)) else 8192
            self.current_memory += (len(key) + new_size - old_size)
            
            # Store the data
            self.data[key] = value
            
            # Check if we need to evict data
            if self.current_memory > self.max_memory:
                self._evict_items()
            
    def delete(self, key):
        """Delete key-value pair"""
        with self.lock:
            if isinstance(key, bytes):
                key = key.decode('utf-8')
                
            if key in self.data:
                # Update memory usage estimate
                old_value = self.data[key]
                old_size = len(old_value) if isinstance(old_value, (str, bytes)) else 8192
                self.current_memory -= (len(key) + old_size)
                
                del self.data[key]
                
                # Also remove from tracking
                if key in self.access_count:
                    del self.access_count[key]
                if key in self.last_access:
                    del self.last_access[key]
                
            # Also try to delete from disk
            key_hash = hashlib.md5(key.encode() if isinstance(key, str) else key).hexdigest()
            file_path = os.path.join(self.overflow_dir, key_hash)
            if os.path.exists(file_path):
                try:
                    os.remove(file_path)
                except:
                    pass
                
    def write(self, batch):
        """Write batch of operations"""
        # This is a simplified implementation
        for op, key, value in batch.operations:
            if op == 'put':
                self.put(key, value)
            elif op == 'delete':
                self.delete(key)
        return True
        
    def WriteBatch(self):
        """Create a write batch"""
        return InMemoryBatch(self)
        
    def iteritems(self):
        """Iterate over items"""
        with self.lock:
            # Make a copy to avoid threading issues
            items = list(self.data.items())
            
        return InMemoryIterator(items)
    
    def close(self):
        """Close the database"""
        self.running = False
        if hasattr(self, 'monitor_thread') and self.monitor_thread.is_alive():
            self.monitor_thread.join(timeout=2)
            
        # Clear data to free memory
        with self.lock:
            self.data = {}
            self.access_count = {}
            self.last_access = {}
        
class InMemoryBatch:
    def __init__(self, db):
        self.db = db
        self.operations = []
        
    def put(self, key, value):
        """Add put operation to batch"""
        self.operations.append(('put', key, value))
        
    def delete(self, key):
        """Add delete operation to batch"""
        self.operations.append(('delete', key))
        
class InMemoryIterator:
    def __init__(self, items):
        self.items = items
        self.index = 0
        
    def seek(self, prefix):
        """Seek to prefix"""
        self.index = 0
        
    def __iter__(self):
        return self
        
    def __next__(self):
        if self.index >= len(self.items):
            raise StopIteration
        item = self.items[self.index]
        self.index += 1
        return item

class StorageManager:
    def __init__(self, data_dir="blockchain_data", use_compression=True, max_memory_mb=512):
        self.data_dir = data_dir
        self.lock = threading.Lock()
        self.use_compression = use_compression
        
        # In-memory storage with LRU cache behavior
        self.blocks_cache = OrderedDict()  # height -> Block
        self.blocks_by_hash_cache = {}  # hash -> Block
        self.account_balances = {}  # address -> balance
        self.total_issued = 0
        self.transaction_index = {}  # tx_hash -> (block_height, tx_index)
        
        # Cache size limits
        self.max_blocks_cache = 1000
        self.max_memory_mb = max_memory_mb
        
        # Index for faster state computation
        self.state_index = {}  # address -> [(block_height, tx_index, amount)]
        
        # Add a compatible state_db for node_identity using the InMemoryDB
        self.state_db = InMemoryDB(max_memory_mb=self.max_memory_mb // 2)
        
        # Snapshot intervals
        self.snapshot_interval = 100  # blocks
        self.last_snapshot = -1
        
        # Create snapshot directory
        self.snapshot_dir = os.path.join(data_dir, "snapshots")
        os.makedirs(self.snapshot_dir, exist_ok=True)
        
        # Statistics
        self.stats = {
            'cache_hits': 0,
            'cache_misses': 0,
            'blocks_saved': 0,
            'blocks_loaded': 0,
            'snapshots_created': 0,
            'snapshots_loaded': 0
        }
        
        # Load latest snapshot if available
        self._load_latest_snapshot()
        
        logging.info(f"Initialized optimized in-memory StorageManager with {self.max_memory_mb}MB memory limit")
    
    def _load_latest_snapshot(self):
        """Load the latest snapshot if available"""
        try:
            snapshot_files = [f for f in os.listdir(self.snapshot_dir) 
                             if f.startswith("snapshot_") and f.endswith(".dat")]
            
            if not snapshot_files:
                return
                
            # Find the latest snapshot
            latest = max(snapshot_files, key=lambda f: int(f.split("_")[1].split(".")[0]))
            snapshot_path = os.path.join(self.snapshot_dir, latest)
            
            try:
                with gzip.open(snapshot_path, 'rb') as f:
                    snapshot_data = pickle.load(f)
                    
                # Extract data
                height = snapshot_data.get("height", -1)
                self.blocks_cache = snapshot_data.get("blocks_cache", OrderedDict())
                self.blocks_by_hash_cache = snapshot_data.get("blocks_by_hash_cache", {})
                self.account_balances = snapshot_data.get("account_balances", {})
                self.total_issued = snapshot_data.get("total_issued", 0)
                self.state_index = snapshot_data.get("state_index", {})
                
                self.last_snapshot = height
                self.stats['snapshots_loaded'] += 1
                
                logging.info(f"Loaded blockchain snapshot at height {height}")
            except Exception as e:
                logging.error(f"Error loading snapshot {snapshot_path}: {e}")
        except Exception as e:
            logging.error(f"Error finding latest snapshot: {e}")
    
    def _create_snapshot(self, height):
        """Create a snapshot of current state"""
        snapshot_path = os.path.join(self.snapshot_dir, f"snapshot_{height}.dat")
        
        try:
            # Prepare snapshot data
            snapshot_data = {
                "height": height,
                "blocks_cache": self.blocks_cache,
                "blocks_by_hash_cache": self.blocks_by_hash_cache,
                "account_balances": self.account_balances,
                "total_issued": self.total_issued,
                "state_index": self.state_index,
                "timestamp": time.time()
            }
            
            # Save to file with compression
            if self.use_compression:
                with gzip.open(snapshot_path, 'wb') as f:
                    pickle.dump(snapshot_data, f)
            else:
                with open(snapshot_path, 'wb') as f:
                    pickle.dump(snapshot_data, f)
                
            self.last_snapshot = height
            self.stats['snapshots_created'] += 1
            
            # Clean up old snapshots
            self._clean_old_snapshots()
            
            logging.info(f"Created blockchain snapshot at height {height}")
            return True
        except Exception as e:
            logging.error(f"Error creating snapshot: {e}")
            return False
    
    def _clean_old_snapshots(self, keep=5):
        """Clean up old snapshots, keeping only the most recent ones"""
        try:
            snapshot_files = [f for f in os.listdir(self.snapshot_dir) 
                             if f.startswith("snapshot_") and f.endswith(".dat")]
            
            if len(snapshot_files) <= keep:
                return
                
            # Sort by height (newest first)
            sorted_snapshots = sorted(snapshot_files, 
                                     key=lambda f: int(f.split("_")[1].split(".")[0]),
                                     reverse=True)
            
            # Delete older snapshots
            for old_file in sorted_snapshots[keep:]:
                try:
                    os.remove(os.path.join(self.snapshot_dir, old_file))
                except Exception as e:
                    logging.debug(f"Error deleting old snapshot {old_file}: {e}")
        except Exception as e:
            logging.error(f"Error cleaning old snapshots: {e}")
    
    def save_block(self, block):
        """Save block to memory with optimized indexing"""
        with self.lock:
            # Serialize block
            block_dict = block.to_dict() if hasattr(block, 'to_dict') else block
            
            # Add block to caches
            block_height = block.index if hasattr(block, 'index') else block.get('index', 0)
            block_hash = block.hash if hasattr(block, 'hash') else block.get('hash', '')
            
            self.blocks_cache[block_height] = block
            self.blocks_by_hash_cache[block_hash] = block
            
            # Maintain LRU cache for blocks
            if len(self.blocks_cache) > self.max_blocks_cache:
                # Remove oldest block from cache
                oldest_height, _ = next(iter(self.blocks_cache.items()))
                oldest_block = self.blocks_cache[oldest_height]
                oldest_hash = oldest_block.hash if hasattr(oldest_block, 'hash') else oldest_block.get('hash', '')
                
                # Remove from caches
                del self.blocks_cache[oldest_height]
                if oldest_hash in self.blocks_by_hash_cache:
                    del self.blocks_by_hash_cache[oldest_hash]
            
            # Index transactions for faster state computation
            transactions = []
            if hasattr(block, 'transactions'):
                transactions = block.transactions
            elif isinstance(block, dict) and 'transactions' in block:
                transactions = block['transactions']
                
            for tx_idx, tx in enumerate(transactions):
                # Generate transaction hash
                if isinstance(tx, dict):
                    tx_json = json.dumps(tx, sort_keys=True).encode()
                    tx_hash = hashlib.sha256(tx_json).hexdigest()
                else:
                    # Handle if tx is an object
                    tx_hash = tx.hash if hasattr(tx, 'hash') else str(tx)
                
                # Index transaction location
                self.transaction_index[tx_hash] = (block_height, tx_idx)
                
                # Update state index for fast balance calculations
                sender = None
                recipient = None
                amount = 0
                
                if isinstance(tx, dict):
                    sender = tx.get("sender")
                    recipient = tx.get("recipient")
                    amount = tx.get("amount", 0)
                else:
                    sender = tx.sender if hasattr(tx, 'sender') else None
                    recipient = tx.recipient if hasattr(tx, 'recipient') else None
                    amount = tx.amount if hasattr(tx, 'amount') else 0
                
                if sender == "network":
                    # Coinbase transaction
                    if recipient not in self.state_index:
                        self.state_index[recipient] = []
                    
                    self.state_index[recipient].append((block_height, tx_idx, amount))
                else:
                    # Regular transaction
                    if sender and sender not in self.state_index:
                        self.state_index[sender] = []
                    
                    if recipient and recipient not in self.state_index:
                        self.state_index[recipient] = []
                    
                    # Debit sender
                    if sender:
                        self.state_index[sender].append((block_height, tx_idx, -amount))
                    
                    # Credit recipient
                    if recipient:
                        self.state_index[recipient].append((block_height, tx_idx, amount))
            
            # Update balances incrementally
            self.update_state(block)
            
            # Create snapshot periodically
            if block_height % self.snapshot_interval == 0 and block_height > self.last_snapshot:
                self._create_snapshot(block_height)
            
            self.stats['blocks_saved'] += 1
            logging.info(f"Block {block_height} saved to memory")
            return True
    
    def get_block(self, height=None, block_hash=None):
        """Get block by height or hash with optimized caching"""
        try:
            if height is not None:
                # Get directly by height
                if height in self.blocks_cache:
                    self.stats['cache_hits'] += 1
                    return self.blocks_cache.get(height)
                self.stats['cache_misses'] += 1
                return None
            elif block_hash is not None:
                # Get by hash 
                if block_hash in self.blocks_by_hash_cache:
                    self.stats['cache_hits'] += 1
                    return self.blocks_by_hash_cache.get(block_hash)
                self.stats['cache_misses'] += 1
                return None
            else:
                return None
        except Exception as e:
            logging.error(f"Error getting block: {e}")
            return None
    
    def get_blockchain_height(self):
        """Returns the current blockchain height"""
        try:
            if not self.blocks_cache:
                return -1
            return max(self.blocks_cache.keys())
        except Exception as e:
            logging.error(f"Error getting blockchain height: {e}")
            return -1
    
    def get_latest_block(self):
        """Returns the latest block"""
        height = self.get_blockchain_height()
        if height >= 0:
            return self.blocks_cache.get(height)
        return None
    
    def get_blocks_range(self, start_height, end_height):
        """Gets a range of blocks with pagination for efficiency"""
        blocks = []
        for height in range(start_height, min(end_height + 1, start_height + 100)):
            block = self.blocks_cache.get(height)
            if block:
                blocks.append(block)
        return blocks
    
    def update_account_balance(self, address, balance):
        """Updates account balance in memory"""
        self.account_balances[address] = balance
    
    def get_account_balance(self, address):
        """Gets account balance from memory"""
        return self.account_balances.get(address, 0)
    
    def save_total_issued(self, total):
        """Saves total amount of issued coins"""
        self.total_issued = total
    
    def get_total_issued(self):
        """Gets total amount of issued coins"""
        return self.total_issued
    
    def update_state(self, block):
        """Update state based on block transactions"""
        transactions = []
        if hasattr(block, 'transactions'):
            transactions = block.transactions
        elif isinstance(block, dict) and 'transactions' in block:
            transactions = block['transactions']
            
        for tx in transactions:
            sender = None
            recipient = None
            amount = 0
            
            if isinstance(tx, dict):
                sender = tx.get("sender")
                recipient = tx.get("recipient")
                amount = tx.get("amount", 0)
            else:
                sender = tx.sender if hasattr(tx, 'sender') else None
                recipient = tx.recipient if hasattr(tx, 'recipient') else None
                amount = tx.amount if hasattr(tx, 'amount') else 0
            
            if sender == "network":
                # Coinbase transaction
                self.total_issued += amount
                self.account_balances[recipient] = self.account_balances.get(recipient, 0) + amount
            else:
                # Regular transaction
                if sender:
                    # Update sender balance
                    sender_balance = self.account_balances.get(sender, 0)
                    self.account_balances[sender] = sender_balance - amount
                
                if recipient:
                    # Update recipient balance
                    self.account_balances[recipient] = self.account_balances.get(recipient, 0) + amount
    
    def compute_state_from_blocks(self):
        """
        Computes state (balances) from blocks using optimized index
        Much faster than traversing all blocks
        """
        if self.account_balances and self.total_issued > 0:
            # State already computed
            return self.account_balances.copy(), self.total_issued
        
        # Compute from state index
        state = defaultdict(float)
        total_issued = 0
        
        for address, transactions in self.state_index.items():
            balance = 0
            for height, tx_idx, amount in transactions:
                balance += amount
                if amount > 0 and self._is_coinbase_transaction(height, tx_idx):
                    total_issued += amount
            
            state[address] = balance
        
        return dict(state), total_issued
    
    def _is_coinbase_transaction(self, block_height, tx_idx):
        """Check if a transaction is a coinbase transaction"""
        try:
            block = self.get_block(height=block_height)
            if not block:
                return False
                
            transactions = []
            if hasattr(block, 'transactions'):
                transactions = block.transactions
            elif isinstance(block, dict) and 'transactions' in block:
                transactions = block['transactions']
                
            if tx_idx >= len(transactions):
                return False
                
            tx = transactions[tx_idx]
            
            if isinstance(tx, dict):
                return tx.get("sender") == "network"
            else:
                return getattr(tx, 'sender', '') == "network"
        except Exception:
            return False
    
    def create_snapshot(self, output_path=None):
        """Creates a snapshot at specified path or default location"""
        height = self.get_blockchain_height()
        
        if output_path is None:
            output_path = os.path.join(self.snapshot_dir, f"snapshot_{height}.json")
        
        try:
            # Create snapshot structure
            snapshot = {
                "height": height,
                "timestamp": time.time(),
                "total_issued": self.total_issued,
                "state": self.account_balances,
                "latest_block_hash": self.get_latest_block().hash if height >= 0 else None
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
                
            # Update state
            self.account_balances = state
            self.total_issued = total_issued
            
            logging.info(f"Loaded blockchain snapshot at height {height}")
            return True
        except Exception as e:
            logging.error(f"Error loading snapshot: {e}")
            return False
    
    def get_transaction_by_hash(self, tx_hash):
        """Get transaction by its hash"""
        if tx_hash not in self.transaction_index:
            return None
            
        block_height, tx_idx = self.transaction_index[tx_hash]
        block = self.get_block(height=block_height)
        
        if not block:
            return None
            
        transactions = []
        if hasattr(block, 'transactions'):
            transactions = block.transactions
        elif isinstance(block, dict) and 'transactions' in block:
            transactions = block['transactions']
            
        if tx_idx >= len(transactions):
            return None
            
        tx = transactions[tx_idx]
        
        # If tx is a dict, add block info
        if isinstance(tx, dict):
            tx_copy = tx.copy()
            tx_copy['block_height'] = block_height
            tx_copy['tx_index'] = tx_idx
            tx_copy['tx_hash'] = tx_hash
            return tx_copy
        
        # If tx is an object, return as is
        return tx
    
    def get_transactions_by_address(self, address, limit=100, offset=0):
        """Get transactions for a specific address"""
        if address not in self.state_index:
            return []
            
        # Get transactions involving this address
        tx_list = []
        for height, tx_idx, amount in self.state_index[address]:
            block = self.get_block(height=height)
            if not block:
                continue
                
            transactions = []
            if hasattr(block, 'transactions'):
                transactions = block.transactions
            elif isinstance(block, dict) and 'transactions' in block:
                transactions = block['transactions']
                
            if tx_idx >= len(transactions):
                continue
                
            tx = transactions[tx_idx]
            
            # Create transaction info dict
            tx_info = {
                'block_height': height,
                'tx_index': tx_idx,
                'amount': abs(amount),
                'direction': 'in' if amount > 0 else 'out',
                'timestamp': block.header.timestamp if hasattr(block, 'header') else block.get('timestamp', 0)
            }
            
            # Add more details from transaction
            if isinstance(tx, dict):
                tx_info.update({
                    'sender': tx.get('sender', ''),
                    'recipient': tx.get('recipient', ''),
                    'hash': hashlib.sha256(json.dumps(tx, sort_keys=True).encode()).hexdigest()
                })
            else:
                tx_info.update({
                    'sender': tx.sender if hasattr(tx, 'sender') else '',
                    'recipient': tx.recipient if hasattr(tx, 'recipient') else '',
                    'hash': tx.hash if hasattr(tx, 'hash') else ''
                })
                
            tx_list.append(tx_info)
            
        # Sort by height and index (newest first)
        tx_list.sort(key=lambda x: (x['block_height'], x['tx_index']), reverse=True)
        
        # Apply pagination
        return tx_list[offset:offset+limit]
    
    def get_stats(self):
        """Get storage statistics"""
        return {
            'memory_usage_mb': self.current_memory / (1024 * 1024) if hasattr(self, 'current_memory') else None,
            'blocks_count': len(self.blocks_cache),
            'accounts_count': len(self.account_balances),
            'transactions_count': len(self.transaction_index),
            'latest_height': self.get_blockchain_height(),
            'last_snapshot_height': self.last_snapshot,
            'stats': self.stats
        }
        
    def archive_blocks(self, max_blocks_to_keep=1000):
        """Archive old blocks to save memory"""
        current_height = self.get_blockchain_height()
        if current_height < max_blocks_to_keep:
            return 0
            
        oldest_height_to_keep = current_height - max_blocks_to_keep
        
        # Archive blocks older than oldest_height_to_keep
        blocks_archived = 0
        
        with self.lock:
            heights_to_archive = [h for h in self.blocks_cache.keys() if h < oldest_height_to_keep]
            
            for height in heights_to_archive:
                # Get block before removing from cache
                block = self.blocks_cache[height]
                block_hash = block.hash if hasattr(block, 'hash') else block.get('hash', '')
                
                # Remove from caches
                del self.blocks_cache[height]
                if block_hash in self.blocks_by_hash_cache:
                    del self.blocks_by_hash_cache[block_hash]
                    
                blocks_archived += 1
        
        logging.info(f"Archived {blocks_archived} blocks older than height {oldest_height_to_keep}")
        return blocks_archived