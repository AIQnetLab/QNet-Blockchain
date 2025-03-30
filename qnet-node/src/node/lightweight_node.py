#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: lightweight_node.py
Lightweight node implementation for QNet
Optimized for mobile devices and environments with limited resources
"""

import os
import json
import logging
import time
import threading
import hashlib
import base64
import socket
import requests
from typing import Dict, Any, List, Optional, Union, Set, Tuple

# Import crypto components
from key_manager import get_key_manager

class LightweightNode:
    """
    Lightweight node implementation for QNet.
    Supports simplified payment verification (SPV) and provides
    basic blockchain interaction with minimal resource usage.
    """
    
    def __init__(self, config=None):
        """
        Initialize the lightweight node.
        
        Args:
            config: Configuration object or dictionary
        """
        # Default configuration
        self.config = {
            'network': os.environ.get('QNET_NETWORK', 'testnet'),
            'api_nodes': os.environ.get('QNET_API_NODES', 'http://localhost:8000').split(','),
            'sync_interval_seconds': int(os.environ.get('QNET_SYNC_INTERVAL', '60')),
            'max_block_headers': int(os.environ.get('QNET_MAX_BLOCK_HEADERS', '1000')),
            'data_dir': os.environ.get('QNET_DATA_DIR', './data'),
            'block_headers_file': os.environ.get('QNET_BLOCK_HEADERS_FILE', './data/block_headers.json'),
            'enable_transaction_relay': os.environ.get('QNET_TX_RELAY', 'false').lower() == 'true',
            'node_discovery_enabled': os.environ.get('QNET_NODE_DISCOVERY', 'true').lower() == 'true',
            'max_peers': int(os.environ.get('QNET_MAX_PEERS', '10')),
            'min_peers': int(os.environ.get('QNET_MIN_PEERS', '3')),
            'battery_saving_mode': os.environ.get('QNET_BATTERY_SAVING', 'false').lower() == 'true',
        }
        
        # Override with provided config if available
        if config:
            if hasattr(config, '__getitem__'):
                for key, value in self.config.items():
                    if key in config:
                        self.config[key] = config[key]
            else:
                for key in self.config.keys():
                    if hasattr(config, key):
                        self.config[key] = getattr(config, key)
        
        # Initialize key manager
        self.key_manager = get_key_manager()
        
        # Initialize data structures
        self.block_headers = []
        self.merkle_proofs = {}
        self.known_transactions = {}
        self.pending_transactions = []
        self.peers = set(self.config['api_nodes'])
        self.active_peers = set()
        self.node_id = None
        self.wallet_address = None
        
        # Initialize sync state
        self.last_sync_time = 0
        self.current_height = 0
        self.sync_in_progress = False
        self.is_running = False
        self.sync_thread = None
        
        # Load stored data
        self._load_stored_data()
        
        # Generate or load node identity
        self._initialize_identity()
        
        logging.info(f"Lightweight node initialized for {self.config['network']} network")
    
    def start(self):
        """Start the lightweight node."""
        if self.is_running:
            logging.warning("Node is already running")
            return
            
        self.is_running = True
        
        # Start sync thread
        self.sync_thread = threading.Thread(
            target=self._sync_loop,
            daemon=True
        )
        self.sync_thread.start()
        
        # If node discovery is enabled, start peer discovery
        if self.config['node_discovery_enabled']:
            self._discover_peers()
            
        logging.info("Lightweight node started")
    
    def stop(self):
        """Stop the lightweight node."""
        if not self.is_running:
            return
            
        self.is_running = False
        
        # Wait for sync thread to stop
        if self.sync_thread and self.sync_thread.is_alive():
            self.sync_thread.join(timeout=1.0)
            
        # Save data
        self._save_stored_data()
        
        logging.info("Lightweight node stopped")
    
    def _initialize_identity(self):
        """Initialize node identity with cryptographic keys."""
        try:
            # Generate a node ID based on the hostname and a random value
            hostname = socket.gethostname()
            random_suffix = hashlib.sha256(os.urandom(32)).hexdigest()[:8]
            self.node_id = f"light-{hostname}-{random_suffix}"
            
            # Load or create keys for this node ID
            public_key, _ = self.key_manager.load_or_create_node_keys(self.node_id)
            
            # Derive wallet address
            self.wallet_address = hashlib.sha256(public_key).hexdigest()
            
            logging.info(f"Node identity initialized: {self.node_id}")
            logging.info(f"Wallet address: {self.wallet_address}")
            
        except Exception as e:
            logging.error(f"Error initializing identity: {e}")
    
    def _load_stored_data(self):
        """Load stored data from files."""
        # Create data directory if it doesn't exist
        os.makedirs(self.config['data_dir'], exist_ok=True)
        
        # Load block headers
        block_headers_file = self.config['block_headers_file']
        if os.path.exists(block_headers_file):
            try:
                with open(block_headers_file, 'r') as f:
                    data = json.load(f)
                    self.block_headers = data.get('headers', [])
                    self.current_height = len(self.block_headers)
                    
                    # Extract merkle roots for future verification
                    for header in self.block_headers:
                        if 'merkle_root' in header:
                            self.merkle_proofs[header['height']] = {
                                'merkle_root': header['merkle_root']
                            }
                    
                    logging.info(f"Loaded {len(self.block_headers)} block headers from {block_headers_file}")
            except Exception as e:
                logging.error(f"Error loading block headers: {e}")
    
    def _save_stored_data(self):
        """Save data to files."""
        # Create data directory if it doesn't exist
        os.makedirs(self.config['data_dir'], exist_ok=True)
        
        # Save block headers
        block_headers_file = self.config['block_headers_file']
        try:
            with open(block_headers_file, 'w') as f:
                json.dump({'headers': self.block_headers}, f)
                
            logging.info(f"Saved {len(self.block_headers)} block headers to {block_headers_file}")
        except Exception as e:
            logging.error(f"Error saving block headers: {e}")
    
    def _sync_loop(self):
        """Main synchronization loop."""
        while self.is_running:
            try:
                # Check if it's time to sync
                current_time = time.time()
                time_since_last_sync = current_time - self.last_sync_time
                
                # Only sync if enough time has passed or we haven't synced yet
                if time_since_last_sync >= self.config['sync_interval_seconds'] or self.last_sync_time == 0:
                    # Battery saving mode: don't sync if device is on battery
                    if self.config['battery_saving_mode'] and self._is_on_battery():
                        logging.info("Skipping sync due to battery saving mode")
                    else:
                        self.sync()
                
                # Adjust sleep time based on battery saving mode
                sleep_time = self.config['sync_interval_seconds']
                if self.config['battery_saving_mode'] and self._is_on_battery():
                    sleep_time *= 3  # Sleep longer if on battery
                    
                time.sleep(min(sleep_time, 10))  # Sleep max 10 seconds at a time for responsiveness
                
            except Exception as e:
                logging.error(f"Error in sync loop: {e}")
                time.sleep(10)  # Sleep on error to prevent tight loop
    
    def sync(self):
        """
        Synchronize with the network.
        Get latest block headers and update transaction status.
        """
        if self.sync_in_progress:
            logging.info("Sync already in progress, skipping")
            return
            
        self.sync_in_progress = True
        self.last_sync_time = time.time()
        
        try:
            # Update peers list
            if self.config['node_discovery_enabled'] and len(self.active_peers) < self.config['min_peers']:
                self._discover_peers()
            
            # Get latest block headers
            new_headers = self._get_new_block_headers()
            if new_headers:
                # Process new block headers
                self._process_block_headers(new_headers)
                
                # Update transaction status for known transactions
                self._update_transaction_status()
                
                logging.info(f"Sync completed, current height: {self.current_height}")
            else:
                logging.info("No new blocks found")
                
        except Exception as e:
            logging.error(f"Error during sync: {e}")
            
        finally:
            self.sync_in_progress = False
    
    def _get_new_block_headers(self) -> List[Dict[str, Any]]:
        """
        Get new block headers from the network.
        
        Returns:
            List of new block headers
        """
        # Start from current height + 1
        start_height = self.current_height + 1
        
        # Try each peer until we get a response
        for peer in list(self.active_peers) + list(self.peers):
            try:
                # Construct API URL
                url = f"{peer}/api/blocks/headers"
                params = {
                    'start_height': start_height,
                    'limit': 100
                }
                
                # Request block headers
                response = requests.get(url, params=params, timeout=10)
                if response.status_code == 200:
                    data = response.json()
                    headers = data.get('headers', [])
                    
                    # If the peer is not in active peers, add it
                    if peer not in self.active_peers:
                        self.active_peers.add(peer)
                        
                    return headers
                    
            except Exception as e:
                logging.warning(f"Error getting block headers from {peer}: {e}")
                # If the peer failed, remove it from active peers
                if peer in self.active_peers:
                    self.active_peers.remove(peer)
        
        # If we got here, no peer responded
        logging.warning("Failed to get block headers from any peer")
        return []
    
    def _process_block_headers(self, headers: List[Dict[str, Any]]):
        """
        Process new block headers.
        
        Args:
            headers: List of new block headers
        """
        # Validate and add headers
        for header in headers:
            # Validate header (simplified)
            if not self._validate_block_header(header):
                logging.warning(f"Invalid block header at height {header.get('height')}")
                break
                
            # Add to block headers
            self.block_headers.append(header)
            
            # Extract merkle root for future verification
            if 'merkle_root' in header:
                self.merkle_proofs[header['height']] = {
                    'merkle_root': header['merkle_root']
                }
                
            # Update current height
            self.current_height = header['height']
        
        # Trim block headers if needed
        if len(self.block_headers) > self.config['max_block_headers']:
            self.block_headers = self.block_headers[-self.config['max_block_headers']:]
    
    def _validate_block_header(self, header: Dict[str, Any]) -> bool:
        """
        Validate a block header.
        
        Args:
            header: Block header to validate
            
        Returns:
            True if valid, False otherwise
        """
        # Check required fields
        required_fields = ['height', 'hash', 'prev_hash', 'timestamp', 'merkle_root']
        for field in required_fields:
            if field not in header:
                logging.warning(f"Block header missing required field: {field}")
                return False
        
        # Check height continuity
        if header['height'] != self.current_height + 1:
            logging.warning(f"Block height mismatch: expected {self.current_height + 1}, got {header['height']}")
            return False
            
        # Check previous hash (except for first block)
        if self.block_headers and header['prev_hash'] != self.block_headers[-1]['hash']:
            logging.warning(f"Block prev_hash mismatch: expected {self.block_headers[-1]['hash']}, got {header['prev_hash']}")
            return False
            
        # More validation could be added here
        
        return True
    
    def _update_transaction_status(self):
        """Update status of known transactions using SPV."""
        # Skip if no transactions to update
        if not self.known_transactions:
            return
            
        # Try each peer until we get a response
        for peer in list(self.active_peers) + list(self.peers):
            try:
                # Group transactions by block height
                tx_by_height = {}
                for tx_id, tx_data in self.known_transactions.items():
                    if 'block_height' in tx_data:
                        height = tx_data['block_height']
                        if height not in tx_by_height:
                            tx_by_height[height] = []
                        tx_by_height[height].append(tx_id)
                
                # Get Merkle proofs for each transaction
                for height, tx_ids in tx_by_height.items():
                    # Skip if height is beyond our known blocks
                    if height > self.current_height:
                        continue
                        
                    # Skip if we already have the Merkle proof for all transactions at this height
                    if height in self.merkle_proofs and all(tx_id in self.merkle_proofs[height] for tx_id in tx_ids):
                        continue
                        
                    # Get Merkle proofs
                    url = f"{peer}/api/blocks/{height}/merkle_proof"
                    params = {'tx_ids': ','.join(tx_ids)}
                    
                    response = requests.get(url, params=params, timeout=10)
                    if response.status_code == 200:
                        data = response.json()
                        proofs = data.get('proofs', {})
                        
                        # Store and verify proofs
                        for tx_id, proof in proofs.items():
                            if self._verify_merkle_proof(tx_id, proof, height):
                                # Update transaction status
                                if height not in self.merkle_proofs:
                                    self.merkle_proofs[height] = {}
                                self.merkle_proofs[height][tx_id] = proof
                                
                                # Update transaction data
                                if tx_id in self.known_transactions:
                                    self.known_transactions[tx_id]['confirmed'] = True
                                    self.known_transactions[tx_id]['confirmations'] = self.current_height - height
                                
                # If we got to this point, we've updated all transaction statuses successfully
                break
                    
            except Exception as e:
                logging.warning(f"Error updating transaction status from {peer}: {e}")
                # If the peer failed, remove it from active peers
                if peer in self.active_peers:
                    self.active_peers.remove(peer)
    
    def _verify_merkle_proof(self, tx_id: str, proof: Dict[str, Any], height: int) -> bool:
        """
        Verify a Merkle proof for a transaction.
        
        Args:
            tx_id: Transaction ID
            proof: Merkle proof data
            height: Block height
            
        Returns:
            True if valid, False otherwise
        """
        # Check if we have the Merkle root for this height
        if height not in self.merkle_proofs or 'merkle_root' not in self.merkle_proofs[height]:
            logging.warning(f"No Merkle root for height {height}")
            return False
            
        merkle_root = self.merkle_proofs[height]['merkle_root']
        
        # Check if proof contains required data
        if 'path' not in proof or 'index' not in proof:
            logging.warning(f"Invalid Merkle proof structure for tx {tx_id}")
            return False
            
        # Verify the proof
        try:
            current_hash = tx_id
            path = proof['path']
            index = proof['index']
            
            for i, sibling in enumerate(path):
                # Determine left and right nodes
                is_right = (index >> i) & 1
                if is_right:
                    left_node = sibling
                    right_node = current_hash
                else:
                    left_node = current_hash
                    right_node = sibling
                    
                # Compute parent hash
                current_hash = self._hash_merkle_nodes(left_node, right_node)
                
            # Compare computed root with stored root
            return current_hash == merkle_root
            
        except Exception as e:
            logging.error(f"Error verifying Merkle proof: {e}")
            return False
    
    def _hash_merkle_nodes(self, left: str, right: str) -> str:
        """
        Hash two Merkle tree nodes.
        
        Args:
            left: Left node hash
            right: Right node hash
            
        Returns:
            Parent hash
        """
        # Concatenate and hash
        concatenated = bytes.fromhex(left) + bytes.fromhex(right)
        return hashlib.sha256(concatenated).hexdigest()
    
    def _discover_peers(self):
        """Discover peers from known API nodes."""
        # Try each known peer
        for peer in list(self.peers):
            try:
                # Ask for peer list
                url = f"{peer}/api/peers"
                response = requests.get(url, timeout=5)
                
                if response.status_code == 200:
                    data = response.json()
                    new_peers = data.get('peers', [])
                    
                    # Add new peers
                    for new_peer in new_peers:
                        # Skip if already known
                        if new_peer in self.peers:
                            continue
                            
                        # Add to peers
                        self.peers.add(new_peer)
                        
                        # Limit peers count
                        if len(self.peers) >= self.config['max_peers']:
                            break
                            
                    logging.info(f"Discovered {len(new_peers)} new peers, total: {len(self.peers)}")
                    
                    # If we reached max peers, stop discovery
                    if len(self.peers) >= self.config['max_peers']:
                        break
            
            except Exception as e:
                logging.warning(f"Error discovering peers from {peer}: {e}")
    
    def _is_on_battery(self) -> bool:
        """
        Check if device is running on battery (simplified).
        
        Returns:
            True if on battery, False if plugged in or unknown
        """
        try:
            # Try to use psutil if available
            import psutil
            battery = psutil.sensors_battery()
            if battery:
                return not battery.power_plugged
        except Exception:
            pass
            
        # If we can't determine, assume not on battery
        return False
    
    def get_balance(self, address: Optional[str] = None) -> Tuple[float, float]:
        """
        Get balance for the given address or the node's address.
        
        Args:
            address: Address to check (default: node's address)
            
        Returns:
            Tuple of (confirmed_balance, unconfirmed_balance)
        """
        # Use node address if not specified
        if not address:
            address = self.wallet_address
            
        # Calculate balance from known transactions
        confirmed_balance = 0.0
        unconfirmed_balance = 0.0
        
        for tx_id, tx_data in self.known_transactions.items():
            # Skip if transaction is not for this address
            if tx_data.get('address') != address:
                continue
                
            # Add to appropriate balance
            amount = tx_data.get('amount', 0.0)
            if tx_data.get('confirmed', False):
                confirmed_balance += amount
            else:
                unconfirmed_balance += amount
                
        return confirmed_balance, unconfirmed_balance
    
    def get_transaction_history(self, address: Optional[str] = None, limit: int = 100) -> List[Dict[str, Any]]:
        """
        Get transaction history for the given address or the node's address.
        
        Args:
            address: Address to check (default: node's address)
            limit: Maximum number of transactions to return
            
        Returns:
            List of transaction dictionaries
        """
        # Use node address if not specified
        if not address:
            address = self.wallet_address
            
        # Get transactions for this address
        transactions = []
        
        for tx_id, tx_data in self.known_transactions.items():
            # Skip if transaction is not for this address
            if tx_data.get('address') != address:
                continue
                
            # Copy transaction data and add ID
            tx_copy = tx_data.copy()
            tx_copy['tx_id'] = tx_id
            
            # Add to list
            transactions.append(tx_copy)
            
        # Sort by timestamp, newest first
        transactions.sort(key=lambda tx: tx.get('timestamp', 0), reverse=True)
        
        # Limit
        return transactions[:limit]
    
    def create_transaction(self, recipient: str, amount: float, fee: float = 0.001) -> Optional[str]:
        """
        Create a new transaction.
        
        Args:
            recipient: Recipient address
            amount: Amount to send
            fee: Transaction fee
            
        Returns:
            Transaction ID if successful, None otherwise
        """
        # Check if we have enough balance
        confirmed_balance, _ = self.get_balance()
        
        if confirmed_balance < amount + fee:
            logging.error(f"Insufficient balance: {confirmed_balance} < {amount + fee}")
            return None
            
        try:
            # Create transaction
            transaction = {
                'sender': self.wallet_address,
                'recipient': recipient,
                'amount': amount,
                'fee': fee,
                'timestamp': int(time.time())
            }
            
            # Sign transaction
            message = json.dumps(transaction, sort_keys=True)
            transaction['signature'] = self.key_manager.sign_message(message, self.node_id)
            
            # Generate transaction ID
            tx_id = hashlib.sha256(message.encode()).hexdigest()
            
            # Add to pending transactions
            self.pending_transactions.append({
                'tx_id': tx_id,
                'transaction': transaction
            })
            
            # Add to known transactions
            self.known_transactions[tx_id] = {
                'address': self.wallet_address,
                'amount': -amount,  # Negative because it's an outgoing transaction
                'fee': -fee,
                'recipient': recipient,
                'timestamp': transaction['timestamp'],
                'confirmed': False
            }
            
            # If transaction relay is enabled, submit to network
            if self.config['enable_transaction_relay']:
                self._submit_transaction(tx_id, transaction)
                
            return tx_id
            
        except Exception as e:
            logging.error(f"Error creating transaction: {e}")
            return None
    
    def _submit_transaction(self, tx_id: str, transaction: Dict[str, Any]) -> bool:
        """
        Submit a transaction to the network.
        
        Args:
            tx_id: Transaction ID
            transaction: Transaction data
            
        Returns:
            True if successful, False otherwise
        """
        # Try each peer until we get a response
        for peer in list(self.active_peers) + list(self.peers):
            try:
                # Submit transaction
                url = f"{peer}/api/transactions"
                payload = {
                    'tx_id': tx_id,
                    'transaction': transaction
                }
                
                response = requests.post(url, json=payload, timeout=10)
                
                if response.status_code == 200:
                    logging.info(f"Transaction {tx_id} submitted successfully to {peer}")
                    return True
                else:
                    logging.warning(f"Failed to submit transaction to {peer}: {response.status_code} {response.text}")
                    
            except Exception as e:
                logging.warning(f"Error submitting transaction to {peer}: {e}")
                # If the peer failed, remove it from active peers
                if peer in self.active_peers:
                    self.active_peers.remove(peer)
                    
        logging.error(f"Failed to submit transaction {tx_id} to any peer")
        return False

# Helper function to get singleton instance
_lightweight_node_instance = None

def get_lightweight_node(config=None) -> LightweightNode:
    """
    Get or create the singleton lightweight node instance.
    
    Args:
        config: Optional configuration
        
    Returns:
        LightweightNode instance
    """
    global _lightweight_node_instance
    if _lightweight_node_instance is None:
        _lightweight_node_instance = LightweightNode(config)
    return _lightweight_node_instance