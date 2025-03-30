#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: sync_manager.py
Implements fast node synchronization using state snapshots and block headers.
"""

import os
import json
import time
import hashlib
import logging
import threading
import sqlite3
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
from crypto_bindings import verify_merkle_proof, compute_merkle_root

class SyncManager:
    def __init__(self, blockchain, storage_manager, config):
        """Initialize the sync manager with blockchain and config"""
        self.blockchain = blockchain
        self.storage = storage_manager
        self.config = config
        self.peers = {}  # Will be set by main node
        self.sync_lock = threading.Lock()
        self.is_syncing = False
        
        # Database for tracking sync state
        self.db_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sync_data.db")
        self.init_db()
        
        # Stats
        self.last_sync_time = 0
        self.sync_stats = {
            "total_blocks_synced": 0,
            "total_sync_time": 0,
            "last_sync_speed": 0,
            "snapshots_applied": 0
        }
        
    def init_db(self):
        """Initialize SQLite database for sync tracking"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            # Table for tracking sync checkpoints
            cursor.execute('''
            CREATE TABLE IF NOT EXISTS sync_checkpoints (
                height INTEGER PRIMARY KEY,
                block_hash TEXT NOT NULL,
                timestamp REAL NOT NULL
            )
            ''')
            
            # Table for tracking snapshot history
            cursor.execute('''
            CREATE TABLE IF NOT EXISTS snapshots (
                height INTEGER PRIMARY KEY,
                hash TEXT NOT NULL,
                timestamp REAL NOT NULL,
                path TEXT NOT NULL
            )
            ''')
            
            conn.commit()
            conn.close()
            
        except Exception as e:
            logging.error(f"Error initializing sync database: {e}")
            raise e
    
    def create_snapshot(self, output_path=None):
        """
        Create a snapshot of the current blockchain state
        
        Args:
            output_path: Path to save the snapshot file. If None, a default path is used.
            
        Returns:
            Path to the created snapshot file
        """
        with self.sync_lock:
            try:
                # Get current state
                state, total_issued = self.blockchain.compute_state()
                
                # Get current height
                height = len(self.blockchain.chain) - 1
                
                # Create default output path if not provided
                if output_path is None:
                    snapshot_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "snapshots")
                    os.makedirs(snapshot_dir, exist_ok=True)
                    output_path = os.path.join(snapshot_dir, f"snapshot_{height}.json")
                
                # Create snapshot structure
                snapshot = {
                    "height": height,
                    "timestamp": time.time(),
                    "total_issued": total_issued,
                    "state": state,
                    "latest_block_hash": self.blockchain.chain[height].hash if height >= 0 else None,
                    "block_header": {
                        "index": self.blockchain.chain[height].index,
                        "hash": self.blockchain.chain[height].hash,
                        "previous_hash": self.blockchain.chain[height].previous_hash,
                        "timestamp": self.blockchain.chain[height].timestamp,
                        "merkle_root": self.blockchain.chain[height].merkle_root or "",
                        "nonce": self.blockchain.chain[height].nonce
                    }
                }
                
                # Save snapshot to file
                with open(output_path, 'w') as f:
                    json.dump(snapshot, f)
                
                # Calculate snapshot hash for verification
                snapshot_json = json.dumps(snapshot, sort_keys=True).encode()
                snapshot_hash = hashlib.sha256(snapshot_json).hexdigest()
                
                # Save snapshot info to database
                conn = sqlite3.connect(self.db_path)
                cursor = conn.cursor()
                cursor.execute(
                    "INSERT OR REPLACE INTO snapshots (height, hash, timestamp, path) VALUES (?, ?, ?, ?)",
                    (height, snapshot_hash, time.time(), output_path)
                )
                conn.commit()
                conn.close()
                
                logging.info(f"Created blockchain snapshot at height {height} with hash {snapshot_hash}")
                return output_path
                
            except Exception as e:
                logging.error(f"Error creating snapshot: {e}")
                return None
    
    def apply_snapshot(self, snapshot_path):
        """
        Apply a snapshot to fast-sync the blockchain
        
        Args:
            snapshot_path: Path to the snapshot file
            
        Returns:
            bool: True if snapshot was applied successfully
        """
        with self.sync_lock:
            try:
                # Load snapshot
                with open(snapshot_path, 'r') as f:
                    snapshot = json.load(f)
                
                # Verify snapshot structure
                required_fields = ["height", "timestamp", "total_issued", "state", "latest_block_hash", "block_header"]
                if not all(field in snapshot for field in required_fields):
                    logging.error("Invalid snapshot format: missing required fields")
                    return False
                
                # Verify snapshot hash
                snapshot_json = json.dumps(snapshot, sort_keys=True).encode()
                snapshot_hash = hashlib.sha256(snapshot_json).hexdigest()
                
                # Get snapshot height
                height = snapshot["height"]
                
                # Save snapshot info to database for reference
                conn = sqlite3.connect(self.db_path)
                cursor = conn.cursor()
                cursor.execute(
                    "SELECT hash FROM snapshots WHERE height = ?",
                    (height,)
                )
                result = cursor.fetchone()
                
                if result and result[0] != snapshot_hash:
                    logging.error(f"Snapshot hash mismatch for height {height}")
                    conn.close()
                    return False
                
                # Apply snapshot
                if not result:
                    cursor.execute(
                        "INSERT INTO snapshots (height, hash, timestamp, path) VALUES (?, ?, ?, ?)",
                        (height, snapshot_hash, time.time(), snapshot_path)
                    )
                
                # Create a genesis block from the snapshot's block header
                block_header = snapshot["block_header"]
                
                # Clear existing chain data
                self.blockchain.chain = []
                
                # Create a minimal block from the header
                from blockchain import Block
                genesis_block = Block(
                    block_header["index"],
                    block_header["timestamp"],
                    [],  # Empty transactions list for header-only sync
                    block_header["previous_hash"],
                    block_header["nonce"]
                )
                genesis_block.hash = block_header["hash"]
                genesis_block.merkle_root = block_header["merkle_root"]
                
                # Add to chain
                self.blockchain.chain = [genesis_block]
                
                # Apply state
                self.blockchain.state = snapshot["state"]
                self.blockchain.total_issued = snapshot["total_issued"]
                
                # If using storage manager, update it too
                if self.storage:
                    # Save block
                    self.storage.save_block(genesis_block)
                    
                    # Update state
                    for address, balance in snapshot["state"].items():
                        self.storage.update_account_balance(address, balance)
                    
                    # Update total issued
                    self.storage.save_total_issued(snapshot["total_issued"])
                
                # Save checkpoint
                cursor.execute(
                    "INSERT OR REPLACE INTO sync_checkpoints (height, block_hash, timestamp) VALUES (?, ?, ?)",
                    (height, block_header["hash"], time.time())
                )
                
                conn.commit()
                conn.close()
                
                # Update stats
                self.sync_stats["snapshots_applied"] += 1
                
                logging.info(f"Applied snapshot at height {height}")
                return True
                
            except Exception as e:
                logging.error(f"Error applying snapshot: {e}")
                return False
    
    def sync_headers(self, target_peer=None):
        """
        Sync only block headers from network peers
        
        Args:
            target_peer: Optional specific peer to sync from. If None, best peer is chosen.
            
        Returns:
            int: Number of headers synced
        """
        if self.is_syncing:
            logging.info("Sync already in progress")
            return 0
            
        with self.sync_lock:
            self.is_syncing = True
            start_time = time.time()
            
            try:
                # Get current height
                local_height = len(self.blockchain.chain) - 1
                
                # Get target peers
                peers_to_try = []
                if target_peer:
                    peers_to_try = [target_peer]
                else:
                    # Try all active peers, sorted by reputation
                    peers_to_try = sorted(
                        self.peers.keys(),
                        key=lambda p: self.config.reputation.get(p, 0),
                        reverse=True
                    )
                
                if not peers_to_try:
                    logging.warning("No peers available for header sync")
                    self.is_syncing = False
                    return 0
                
                # Find the best peer with the highest chain
                best_peer = None
                best_height = local_height
                
                for peer in peers_to_try:
                    try:
                        response = requests.get(f"http://{peer}/block_headers", timeout=5)
                        if response.status_code == 200:
                            data = response.json()
                            peer_headers = data.get("headers", [])
                            
                            if len(peer_headers) > best_height:
                                best_height = len(peer_headers)
                                best_peer = peer
                    except Exception as e:
                        logging.debug(f"Failed to get headers from {peer}: {e}")
                
                if not best_peer or best_height <= local_height:
                    logging.info(f"Already at the highest known block height {local_height}")
                    self.is_syncing = False
                    return 0
                
                # Sync headers from the best peer
                try:
                    response = requests.get(f"http://{best_peer}/block_headers", timeout=10)
                    if response.status_code != 200:
                        logging.error(f"Failed to get headers from best peer {best_peer}")
                        self.is_syncing = False
                        return 0
                        
                    data = response.json()
                    peer_headers = data.get("headers", [])
                    
                    # Verify and add headers
                    headers_to_add = peer_headers[local_height+1:]
                    
                    if not headers_to_add:
                        logging.info("No new headers to add")
                        self.is_syncing = False
                        return 0
                    
                    # Verify header chain
                    prev_hash = self.blockchain.chain[local_height].hash
                    
                    for header in headers_to_add:
                        if header["previous_hash"] != prev_hash:
                            logging.error(f"Header chain broken at height {header['index']}")
                            self.is_syncing = False
                            return 0
                            
                        # Create a block from the header
                        from blockchain import Block
                        new_block = Block(
                            header["index"],
                            header["timestamp"],
                            [],  # Empty transactions list for header-only sync
                            header["previous_hash"],
                            header["nonce"]
                        )
                        new_block.hash = header["hash"]
                        
                        # Add to chain
                        self.blockchain.chain.append(new_block)
                        
                        # If using storage, save the header
                        if self.storage:
                            self.storage.save_block(new_block)
                        
                        prev_hash = header["hash"]
                    
                    # Save the latest checkpoint
                    conn = sqlite3.connect(self.db_path)
                    cursor = conn.cursor()
                    cursor.execute(
                        "INSERT OR REPLACE INTO sync_checkpoints (height, block_hash, timestamp) VALUES (?, ?, ?)",
                        (self.blockchain.chain[-1].index, self.blockchain.chain[-1].hash, time.time())
                    )
                    conn.commit()
                    conn.close()
                    
                    # Update stats
                    elapsed_time = time.time() - start_time
                    headers_synced = len(headers_to_add)
                    self.sync_stats["total_blocks_synced"] += headers_synced
                    self.sync_stats["total_sync_time"] += elapsed_time
                    self.sync_stats["last_sync_speed"] = headers_synced / elapsed_time if elapsed_time > 0 else 0
                    self.last_sync_time = time.time()
                    
                    logging.info(f"Successfully synced {headers_synced} headers from {best_peer}")
                    self.is_syncing = False
                    return headers_synced
                    
                except Exception as e:
                    logging.error(f"Error syncing headers from {best_peer}: {e}")
                    self.is_syncing = False
                    return 0
                    
            except Exception as e:
                logging.error(f"Error in header sync: {e}")
                self.is_syncing = False
                return 0
    
    def fast_sync(self, target_peer=None):
        """
        Perform a fast sync using both snapshots and header sync
        
        Args:
            target_peer: Optional specific peer to sync from
            
        Returns:
            bool: True if sync was successful
        """
        if self.is_syncing:
            logging.info("Sync already in progress")
            return False
            
        with self.sync_lock:
            self.is_syncing = True
            start_time = time.time()
            
            try:
                # Get current height
                local_height = len(self.blockchain.chain) - 1
                
                # Get target peers
                peers_to_try = []
                if target_peer:
                    peers_to_try = [target_peer]
                else:
                    # Try all active peers, sorted by reputation
                    peers_to_try = sorted(
                        self.peers.keys(),
                        key=lambda p: self.config.reputation.get(p, 0),
                        reverse=True
                    )
                
                if not peers_to_try:
                    logging.warning("No peers available for fast sync")
                    self.is_syncing = False
                    return False
                
                # Step 1: Find best peer with snapshot
                best_peer = None
                best_snapshot = None
                
                for peer in peers_to_try:
                    try:
                        # Check if peer has snapshot capability
                        response = requests.get(f"http://{peer}/api/v1/snapshot/latest", timeout=5)
                        if response.status_code == 200:
                            snapshot_info = response.json()
                            if snapshot_info.get("height", 0) > local_height:
                                best_peer = peer
                                best_snapshot = snapshot_info
                                break
                    except Exception as e:
                        logging.debug(f"Failed to get snapshot info from {peer}: {e}")
                
                # Step 2: If snapshot available, download and apply it
                if best_peer and best_snapshot:
                    try:
                        # Download snapshot
                        snapshot_url = f"http://{best_peer}/api/v1/snapshot/download/{best_snapshot['id']}"
                        response = requests.get(snapshot_url, timeout=30)
                        
                        if response.status_code == 200:
                            # Save snapshot to temp file
                            snapshot_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "snapshots")
                            os.makedirs(snapshot_dir, exist_ok=True)
                            snapshot_path = os.path.join(snapshot_dir, f"downloaded_snapshot_{best_snapshot['height']}.json")
                            
                            with open(snapshot_path, 'wb') as f:
                                f.write(response.content)
                            
                            # Verify snapshot hash if provided
                            if "hash" in best_snapshot:
                                with open(snapshot_path, 'rb') as f:
                                    content = f.read()
                                    hash_value = hashlib.sha256(content).hexdigest()
                                    
                                    if hash_value != best_snapshot["hash"]:
                                        logging.error("Snapshot hash verification failed")
                                        os.remove(snapshot_path)
                                        self.is_syncing = False
                                        return False
                            
                            # Apply snapshot
                            if self.apply_snapshot(snapshot_path):
                                logging.info(f"Successfully applied snapshot from {best_peer} at height {best_snapshot['height']}")
                                
                                # Update local height after applying snapshot
                                local_height = len(self.blockchain.chain) - 1
                            else:
                                logging.error("Failed to apply snapshot")
                                self.is_syncing = False
                                return False
                        else:
                            logging.error(f"Failed to download snapshot: {response.status_code}")
                    except Exception as e:
                        logging.error(f"Error downloading or applying snapshot: {e}")
                
                # Step 3: Sync remaining headers
                headers_synced = self.sync_headers(best_peer)
                
                # Update stats
                elapsed_time = time.time() - start_time
                final_height = len(self.blockchain.chain) - 1
                height_gain = final_height - local_height
                
                logging.info(f"Fast sync completed: {height_gain} blocks gained, took {elapsed_time:.2f} seconds")
                
                self.is_syncing = False
                return height_gain > 0
                
            except Exception as e:
                logging.error(f"Error in fast sync: {e}")
                self.is_syncing = False
                return False
                
    def get_sync_stats(self):
        """Get synchronization statistics"""
        return {
            **self.sync_stats,
            "last_sync_time": self.last_sync_time,
            "current_height": len(self.blockchain.chain) - 1
        }
        
    def auto_snapshot_loop(self):
        """Background loop to create periodic snapshots"""
        snapshot_interval = 1000  # Create snapshot every 1000 blocks
        
        while True:
            try:
                # Get current height
                height = len(self.blockchain.chain) - 1
                
                # Check if we need to create a snapshot
                if height % snapshot_interval == 0 and height > 0:
                    # Check if snapshot for this height already exists
                    conn = sqlite3.connect(self.db_path)
                    cursor = conn.cursor()
                    cursor.execute("SELECT height FROM snapshots WHERE height = ?", (height,))
                    exists = cursor.fetchone()
                    conn.close()
                    
                    if not exists:
                        logging.info(f"Creating automatic snapshot at height {height}")
                        self.create_snapshot()
            except Exception as e:
                logging.error(f"Error in auto snapshot loop: {e}")
                
            time.sleep(60)  # Check every minute