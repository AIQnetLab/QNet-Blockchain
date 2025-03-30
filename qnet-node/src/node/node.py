#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: node.py
Main node implementation for QNet blockchain
"""

import os
import json
import logging
import time
import threading
import base64
import hashlib
import socket
from typing import Dict, Any, List, Optional, Union, Tuple

# Import QNet components
from key_manager import get_key_manager
from consensus import get_consensus
from transaction_validation import validate_transaction_format
import storage_factory

class Node:
    """
    Main blockchain node class for QNet.
    Manages blockchain, processes transactions and participates in consensus.
    """
    
    def __init__(self, config=None, blockchain=None, block_validator=None):
        """
        Initialize the node.
        
        Args:
            config: Node configuration
            blockchain: Blockchain object reference
            block_validator: Optional validator for blocks
        """
        # Default configuration
        self.config = {
            'node_id': os.environ.get('QNET_NODE_ID', socket.gethostname()),
            'network': os.environ.get('QNET_NETWORK', 'testnet'),
            'external_ip': os.environ.get('QNET_EXTERNAL_IP', 'auto'),
            'port': int(os.environ.get('QNET_PORT', '8000')),
            'peers_file': os.environ.get('QNET_PEERS_FILE', '/app/data/peers.json'),
            'max_peers': int(os.environ.get('QNET_MAX_PEERS', '50')),
            'min_peers': int(os.environ.get('QNET_MIN_PEERS', '3')),
            'auto_discovery': os.environ.get('QNET_AUTO_DISCOVERY', 'true').lower() == 'true',
            'mining_enabled': os.environ.get('QNET_MINING_ENABLED', 'true').lower() == 'true',
            'max_pending_tx': int(os.environ.get('QNET_MAX_PENDING_TX', '5000')),
            'max_block_size_kb': int(os.environ.get('QNET_MAX_BLOCK_SIZE', '500')),
            'mining_threads': int(os.environ.get('QNET_MINING_THREADS', '1')),
            'data_dir': os.environ.get('QNET_DATA_DIR', '/app/data'),
            'bootstrap_nodes': os.environ.get('QNET_BOOTSTRAP_NODES', '').split(','),
            'sync_mode': os.environ.get('QNET_SYNC_MODE', 'full'),
            'token_verification_required': os.environ.get('QNET_TOKEN_VERIFICATION', 'true').lower() == 'true',
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
        
        # External components
        self.blockchain = blockchain
        self.block_validator = block_validator
        
        # State components
        self.peers = set()
        self.active_peers = set()
        self.pending_transactions = []
        self.is_mining = False
        self.is_syncing = False
        self.is_running = False
        self.fork_count = 0
        
        # Service providers
        self.key_manager = get_key_manager()
        self.consensus = get_consensus()
        self.storage = storage_factory.get_storage()
        
        # Threads
        self.mining_thread = None
        self.sync_thread = None
        self.discovery_thread = None
        
        # Initialize node
        self._init_node()
    
    def _init_node(self):
        """Initialize node state"""
        # Create necessary directories
        os.makedirs(self.config['data_dir'], exist_ok=True)
        
        # Initialize node keys
        self._init_node_keys()
        
        # Load known peers
        self._load_peers()
    
    def _init_node_keys(self):
        """Initialize node cryptographic keys."""
        if not self.config.get('node_id'):
            logging.warning("Node ID not configured. Cannot initialize keys.")
            return
            
        try:
            # Load or create keys through secure KeyManager
            public_key, _ = self.key_manager.load_or_create_node_keys(self.config['node_id'])
            
            # Store public key in node configuration
            self.config['public_key'] = public_key
            self.config['public_key_str'] = self.key_manager.get_public_key_str(self.config['node_id'])
            
            logging.info(f"Node keys initialized for node {self.config['node_id']}")
        except Exception as e:
            logging.error(f"Failed to initialize node keys: {e}")
    
    def _load_peers(self):
        """Load known peers from file."""
        peers_file = self.config['peers_file']
        
        if os.path.exists(peers_file):
            try:
                with open(peers_file, 'r') as f:
                    data = json.load(f)
                    if 'peers' in data and isinstance(data['peers'], list):
                        for peer in data['peers']:
                            if peer:  # Verify non-empty
                                self.peers.add(peer)
                
                logging.info(f"Loaded {len(self.peers)} peers from {peers_file}")
            except Exception as e:
                logging.error(f"Failed to load peers: {e}")
    
    def _save_peers(self):
        """Save known peers to file."""
        peers_file = self.config['peers_file']
        
        try:
            with open(peers_file, 'w') as f:
                json.dump({'peers': list(self.peers)}, f)
                
            logging.info(f"Saved {len(self.peers)} peers to {peers_file}")
        except Exception as e:
            logging.error(f"Failed to save peers: {e}")
    
    def start(self):
        """Start the node and all necessary threads."""
        if self.is_running:
            logging.warning("Node is already running")
            return
            
        self.is_running = True
        
        # Initialize blockchain if not provided
        if not self.blockchain:
            self._init_blockchain()
            
        # Start peer discovery if enabled
        if self.config['auto_discovery']:
            self._start_discovery()
            
        # Start blockchain synchronization
        self._start_sync()
        
        # Start mining if enabled
        if self.config['mining_enabled']:
            self._start_mining()
            
        logging.info("Node started successfully")
    
    def stop(self):
        """Stop the node and all threads."""
        if not self.is_running:
            return
            
        self.is_running = False
        
        # Stop mining
        self.is_mining = False
        if self.mining_thread and self.mining_thread.is_alive():
            self.mining_thread.join(timeout=2.0)
            
        # Stop syncing
        self.is_syncing = False
        if self.sync_thread and self.sync_thread.is_alive():
            self.sync_thread.join(timeout=2.0)
            
        # Stop discovery
        if self.discovery_thread and self.discovery_thread.is_alive():
            self.discovery_thread.join(timeout=2.0)
            
        # Save state
        self._save_peers()
        if self.blockchain:
            self.blockchain.save_state()
            
        logging.info("Node stopped")
    
    def _init_blockchain(self):
        """Initialize the blockchain if not provided."""
        try:
            from blockchain import Blockchain
            self.blockchain = Blockchain()
            logging.info("Blockchain initialized")
        except ImportError:
            logging.error("Blockchain module not found")
    
    def _start_discovery(self):
        """Start peer discovery thread."""
        self.discovery_thread = threading.Thread(
            target=self._discovery_loop,
            daemon=True
        )
        self.discovery_thread.start()
        logging.info("Peer discovery started")
    
    def _discovery_loop(self):
        """Main loop for peer discovery."""
        while self.is_running:
            try:
                # Skip if we have enough peers
                if len(self.active_peers) >= self.config['max_peers']:
                    time.sleep(60)
                    continue
                    
                # Try to discover new peers
                self._discover_peers()
                
                # Sleep between discovery attempts
                time.sleep(30)
            except Exception as e:
                logging.error(f"Error in peer discovery: {e}")
                time.sleep(30)
    
    def _discover_peers(self):
        """Discover peers from bootstrap nodes and active peers."""
        # Start with bootstrap nodes if we have no active peers
        if not self.active_peers and self.config['bootstrap_nodes']:
            for bootstrap_node in self.config['bootstrap_nodes']:
                if bootstrap_node and bootstrap_node not in self.peers:
                    self.peers.add(bootstrap_node)
        
        # Try to get peers from known peers
        new_peers = set()
        
        for peer in self.peers:
            try:
                # Only query a limited number of peers each time
                if len(new_peers) >= 10:
                    break
                    
                # Get peers from this peer
                peer_list = self._get_peer_list(peer)
                
                if peer_list:
                    # Add peer to active peers
                    self.active_peers.add(peer)
                    
                    # Add new peers
                    for new_peer in peer_list:
                        if new_peer and new_peer not in self.peers:
                            new_peers.add(new_peer)
            except Exception as e:
                logging.debug(f"Failed to get peers from {peer}: {e}")
                # Remove from active peers if failed
                if peer in self.active_peers:
                    self.active_peers.remove(peer)
        
        # Add new peers up to the max limit
        peers_to_add = self.config['max_peers'] - len(self.peers)
        if peers_to_add > 0:
            # Add only up to the limit
            for peer in list(new_peers)[:peers_to_add]:
                self.peers.add(peer)
                
            if new_peers:
                logging.info(f"Discovered {len(new_peers)} new peers")
                
                # Save updated peers list
                self._save_peers()
    
    def _get_peer_list(self, peer: str) -> List[str]:
        """
        Get peer list from a peer.
        
        Args:
            peer: Peer address
            
        Returns:
            List of peer addresses
        """
        # This would use network API to request peers
        # For example: GET http://{peer}/api/peers
        # Implement actual network request here
        return []
    
    def _start_sync(self):
        """Start blockchain synchronization thread."""
        self.is_syncing = True
        self.sync_thread = threading.Thread(
            target=self._sync_loop,
            daemon=True
        )
        self.sync_thread.start()
        logging.info("Blockchain synchronization started")
    
    def _sync_loop(self):
        """Main loop for blockchain synchronization."""
        while self.is_running and self.is_syncing:
            try:
                # Skip if we have no active peers
                if not self.active_peers:
                    time.sleep(5)
                    continue
                    
                # Sync with the network
                self._sync_with_network()
                
                # Sleep between sync attempts
                time.sleep(10)
            except Exception as e:
                logging.error(f"Error in blockchain sync: {e}")
                time.sleep(10)
    
    def _sync_with_network(self):
        """Synchronize blockchain with the network."""
        # Get our current blockchain height
        local_height = len(self.blockchain.chain) if hasattr(self.blockchain, 'chain') else 0
        
        # Find the best peer to sync from
        best_peer = None
        best_height = local_height
        
        for peer in self.active_peers:
            try:
                # Get peer's blockchain height
                peer_height = self._get_peer_height(peer)
                
                if peer_height > best_height:
                    best_height = peer_height
                    best_peer = peer
            except Exception as e:
                logging.debug(f"Failed to get height from peer {peer}: {e}")
                # Remove from active peers if failed
                if peer in self.active_peers:
                    self.active_peers.remove(peer)
        
        # If no better peer found, we're up to date
        if not best_peer:
            return
            
        # Get missing blocks from the best peer
        try:
            missing_blocks = self._get_missing_blocks(best_peer, local_height, best_height)
            
            if not missing_blocks:
                return
                
            # Process and add blocks
            for block in missing_blocks:
                # Validate block before adding
                if self._validate_block(block):
                    # Add to blockchain
                    self.blockchain.add_block(block)
                else:
                    # Invalid block, stop syncing from this peer
                    logging.warning(f"Received invalid block from peer {best_peer}")
                    if best_peer in self.active_peers:
                        self.active_peers.remove(best_peer)
                    break
                    
            logging.info(f"Synchronized {len(missing_blocks)} blocks from peer {best_peer}")
        except Exception as e:
            logging.error(f"Failed to sync with peer {best_peer}: {e}")
            # Remove from active peers if failed
            if best_peer in self.active_peers:
                self.active_peers.remove(best_peer)
    
    def _get_peer_height(self, peer: str) -> int:
        """
        Get blockchain height from a peer.
        
        Args:
            peer: Peer address
            
        Returns:
            Blockchain height
        """
        # This would use network API to request height
        # For example: GET http://{peer}/api/status
        # Implement actual network request here
        return 0
    
    def _get_missing_blocks(self, peer: str, start_height: int, end_height: int) -> List[Any]:
        """
        Get missing blocks from a peer.
        
        Args:
            peer: Peer address
            start_height: Start block height
            end_height: End block height
            
        Returns:
            List of blocks
        """
        # This would use network API to request blocks
        # For example: GET http://{peer}/api/blocks?start={start_height}&end={end_height}
        # Implement actual network request here
        return []
    
    def _validate_block(self, block: Any) -> bool:
        """
        Validate a block.
        
        Args:
            block: Block to validate
            
        Returns:
            True if valid, False otherwise
        """
        # Use custom validator if provided
        if self.block_validator:
            return self.block_validator.validate(block, self.blockchain)
            
        # Basic validation
        try:
            # Verify block structure
            if not hasattr(block, 'header') or not hasattr(block, 'transactions'):
                return False
                
            # Verify block hash
            if not self._verify_block_hash(block):
                return False
                
            # Verify block height
            if block.header.height != len(self.blockchain.chain):
                return False
                
            # Verify previous hash (except for genesis block)
            if block.header.height > 0:
                prev_block = self.blockchain.chain[-1]
                if block.header.prev_hash != prev_block.hash:
                    # Potential fork detected
                    self.fork_count += 1
                    logging.warning(f"Fork detected: expected prev_hash {prev_block.hash}, got {block.header.prev_hash}")
                    return False
                    
            # Verify transactions (simplified version)
            for tx in block.transactions:
                if not validate_transaction_format(tx):
                    return False
                    
            return True
        except Exception as e:
            logging.error(f"Error validating block: {e}")
            return False
    
    def _verify_block_hash(self, block: Any) -> bool:
        """
        Verify block hash.
        
        Args:
            block: Block to verify
            
        Returns:
            True if hash is valid, False otherwise
        """
        try:
            # Calculate expected hash
            header_dict = block.header.__dict__.copy()
            header_dict.pop('hash', None)  # Remove hash field if present
            header_json = json.dumps(header_dict, sort_keys=True).encode()
            expected_hash = hashlib.sha256(header_json).hexdigest()
            
            # Compare with block hash
            return block.hash == expected_hash
        except Exception as e:
            logging.error(f"Error verifying block hash: {e}")
            return False
    
    def _start_mining(self):
        """Start mining thread."""
        self.is_mining = True
        self.mining_thread = threading.Thread(
            target=self._mining_loop,
            daemon=True
        )
        self.mining_thread.start()
        logging.info("Mining started")
    
    def _mining_loop(self):
        """Main loop for mining new blocks."""
        while self.is_running and self.is_mining:
            try:
                # Skip mining if node is syncing
                if self.is_syncing:
                    time.sleep(1)
                    continue
                    
                # Try to mine a new block
                self._mine_block()
                
                # Sleep between mining attempts
                time.sleep(1)
            except Exception as e:
                logging.error(f"Error in mining: {e}")
                time.sleep(5)
    
    def _mine_block(self):
        """Mine a new block using consensus mechanism."""
        # Get current round (blockchain height)
        current_round = len(self.blockchain.chain) if hasattr(self.blockchain, 'chain') else 0
        
        # Check if we are participating in the current round
        round_state = self.consensus.get_round_state()
        if round_state['round_number'] != current_round:
            # Start new round
            self.consensus.start_new_round(current_round)
            round_state = self.consensus.get_round_state()
            
        # Process based on current phase
        phase = round_state['phase']
        
        if phase == 'commit':
            # Generate commitment if we haven't already
            if self.config['node_id'] not in round_state['commits']:
                # Generate commit data
                commit_hash, value, nonce = self.consensus.generate_commit(self.config['node_id'])
                
                # Sign commitment
                signature = self.consensus.sign_commitment(self.config['node_id'], commit_hash)
                
                # Submit commitment
                try:
                    # Prepare token verification data if required
                    token_verification = None
                    if self.config['token_verification_required']:
                        token_verification = self._get_token_verification()
                        
                    # Submit to consensus
                    success, message = self.consensus.submit_commit(
                        self.config['node_id'],
                        commit_hash,
                        signature,
                        token_verification
                    )
                    
                    if success:
                        # Store values for reveal phase
                        self._store_mining_values(value, nonce)
                        logging.info(f"Submitted commitment for round {current_round}")
                    else:
                        logging.warning(f"Failed to submit commitment: {message}")
                except Exception as e:
                    logging.error(f"Error submitting commitment: {e}")
                    
        elif phase == 'reveal':
            # Submit reveal if we haven't already
            if (self.config['node_id'] in round_state['commits'] and 
                self.config['node_id'] not in round_state['reveals']):
                # Get stored values from commit phase
                value, nonce = self._get_mining_values()
                if not value or not nonce:
                    logging.warning("Missing mining values for reveal phase")
                    return
                    
                # Submit reveal
                try:
                    success, message = self.consensus.submit_reveal(
                        self.config['node_id'],
                        value,
                        nonce
                    )
                    
                    if success:
                        logging.info(f"Submitted reveal for round {current_round}")
                    else:
                        logging.warning(f"Failed to submit reveal: {message}")
                except Exception as e:
                    logging.error(f"Error submitting reveal: {e}")
                    
        # Check if round is complete
        if round_state['status'] == 'complete':
            # Check if we won
            if round_state['round_winner'] == self.config['node_id']:
                logging.info(f"We won round {current_round}!")
                
                # Create and add new block
                self._create_and_add_block(round_state)
    
    def _store_mining_values(self, value: str, nonce: str):
        """
        Store mining values for the reveal phase.
        
        Args:
            value: Random value for commit-reveal
            nonce: Nonce used in commitment
        """
        # This would typically be stored in memory for the current round
        # For simplicity, we use instance variables
        self.mining_value = value
        self.mining_nonce = nonce
    
    def _get_mining_values(self) -> Tuple[Optional[str], Optional[str]]:
        """
        Get stored mining values for the reveal phase.
        
        Returns:
            Tuple of (value, nonce) or (None, None) if not available
        """
        value = getattr(self, 'mining_value', None)
        nonce = getattr(self, 'mining_nonce', None)
        return value, nonce
    
    def _get_token_verification(self) -> Optional[Dict[str, Any]]:
        """
        Get token verification data.
        
        Returns:
            Token verification data or None if not available
        """
        try:
            # Try to import token verification module
            from token_verification import get_token_verifier
            verifier = get_token_verifier()
            
            # Get wallet address from node configuration
            wallet_address = self.config.get('wallet_address')
            if not wallet_address:
                logging.warning("No wallet address configured for token verification")
                return None
                
            # Prepare verification data
            verification_data = {
                "wallet_address": wallet_address,
                "node_id": self.config['node_id']
            }
            
            # Sign verification data
            message = f"{self.config['node_id']}:{wallet_address}"
            verification_data["signature"] = self.key_manager.sign_message(message, self.config['node_id'])
            
            return verification_data
        except ImportError:
            logging.warning("Token verification module not available")
            
            # Return mock verification for testing
            return {
                "mock_verified": True,
                "wallet_address": "test_wallet",
                "node_id": self.config['node_id']
            }
    
    def _create_and_add_block(self, round_state: Dict[str, Any]):
        """
        Create and add a new block based on consensus result.
        
        Args:
            round_state: Current consensus round state
        """
        from blockchain import Block, BlockHeader
        
        try:
            # Get blockchain height
            height = len(self.blockchain.chain) if hasattr(self.blockchain, 'chain') else 0
            
            # Get previous block hash
            prev_hash = None
            if height > 0:
                prev_hash = self.blockchain.chain[-1].hash
            else:
                prev_hash = "0" * 64  # Genesis block
                
            # Create block header
            header = BlockHeader(
                height=height,
                prev_hash=prev_hash,
                timestamp=int(time.time()),
                merkle_root=self._calculate_merkle_root(self.pending_transactions),
                difficulty=round_state['difficulty'],
                nonce=round_state.get('winning_value', 0)
            )
            
            # Create new block
            new_block = Block(
                header=header,
                transactions=self.pending_transactions.copy()
            )
            
            # Add block to blockchain
            if self.blockchain.add_block(new_block):
                logging.info(f"Added new block at height {height}")
                
                # Clear pending transactions
                self.pending_transactions = []
            else:
                logging.warning("Failed to add new block")
                
        except Exception as e:
            logging.error(f"Error creating/adding block: {e}")
    
    def _calculate_merkle_root(self, transactions: List[Any]) -> str:
        """
        Calculate Merkle root for transactions.
        
        Args:
            transactions: List of transactions
            
        Returns:
            Merkle root hash
        """
        if not transactions:
            return "0" * 64
            
        # Convert transactions to byte strings
        tx_data = []
        for tx in transactions:
            if isinstance(tx, dict):
                tx_json = json.dumps(tx, sort_keys=True).encode()
                tx_data.append(tx_json)
            else:
                # Handle custom transaction objects
                tx_str = str(tx).encode()
                tx_data.append(tx_str)
        
        # Use crypto bindings if available
        try:
            from crypto_bindings import compute_merkle_root
            return compute_merkle_root(tx_data).hex()
        except ImportError:
            # Fallback to simple implementation
            if len(tx_data) == 1:
                return hashlib.sha256(tx_data[0]).hexdigest()
                
            # Calculate root from transaction hashes
            hashes = [hashlib.sha256(data).digest() for data in tx_data]
            
            while len(hashes) > 1:
                if len(hashes) % 2 == 1:
                    hashes.append(hashes[-1])  # Duplicate last item for odd count
                    
                new_hashes = []
                for i in range(0, len(hashes), 2):
                    combined = hashes[i] + hashes[i+1]
                    new_hash = hashlib.sha256(combined).digest()
                    new_hashes.append(new_hash)
                    
                hashes = new_hashes
                
            return hashes[0].hex()
    
    def add_transaction(self, transaction: Any) -> bool:
        """
        Add a transaction to the pending transactions pool.
        
        Args:
            transaction: Transaction to add
            
        Returns:
            True if added successfully, False otherwise
        """
        # Skip if we already have too many pending transactions
        if len(self.pending_transactions) >= self.config['max_pending_tx']:
            logging.warning("Transaction pool full, rejecting transaction")
            return False
            
        # Validate transaction
        if not self._validate_transaction(transaction):
            logging.warning("Invalid transaction, rejecting")
            return False
            
        # Add to pending transactions
        self.pending_transactions.append(transaction)
        
        logging.debug(f"Added transaction to pool ({len(self.pending_transactions)}/{self.config['max_pending_tx']})")
        return True
    
    def _validate_transaction(self, transaction: Any) -> bool:
        """
        Validate a transaction.
        
        Args:
            transaction: Transaction to validate
            
        Returns:
            True if valid, False otherwise
        """
        try:
            # Validate format
            if not validate_transaction_format(transaction):
                return False
                
            # Extract transaction data
            if isinstance(transaction, dict):
                sender = transaction.get('sender')
                signature = transaction.get('signature')
                public_key = transaction.get('public_key')
                amount = transaction.get('amount', 0)
            else:
                sender = getattr(transaction, 'sender', None)
                signature = getattr(transaction, 'signature', None)
                public_key = getattr(transaction, 'public_key', None)
                amount = getattr(transaction, 'amount', 0)
                
            # Verify signature
            if sender != 'network':  # Skip validation for coinbase transactions
                # Prepare message for signature verification
                message_data = {}
                if isinstance(transaction, dict):
                    message_data = {k: v for k, v in transaction.items() if k != 'signature'}
                else:
                    # Convert object to dict
                    message_data = {k: getattr(transaction, k) for k in dir(transaction) 
                                  if not k.startswith('_') and not callable(getattr(transaction, k))
                                  and k != 'signature'}
                                  
                message = json.dumps(message_data, sort_keys=True)
                
                # Verify signature
                if not self.key_manager.verify_signature(message, signature, public_key):
                    logging.warning(f"Invalid signature for transaction from {sender}")
                    return False
                    
                # Verify balance (if blockchain is available)
                if self.blockchain and hasattr(self.blockchain, 'get_balance'):
                    balance = self.blockchain.get_balance(sender)
                    if balance < amount:
                        logging.warning(f"Insufficient balance for transaction from {sender}: {balance} < {amount}")
                        return False
            
            return True
        except Exception as e:
            logging.error(f"Error validating transaction: {e}")
            return False
    
    def broadcast_transaction(self, transaction: Any) -> int:
        """
        Broadcast a transaction to all active peers.
        
        Args:
            transaction: Transaction to broadcast
            
        Returns:
            Number of peers transaction was sent to
        """
        # First add to our own pending transactions
        if not self.add_transaction(transaction):
            return 0
            
        # Broadcast to peers
        broadcast_count = 0
        
        for peer in self.active_peers:
            try:
                # Send transaction to peer
                success = self._send_transaction_to_peer(peer, transaction)
                if success:
                    broadcast_count += 1
            except Exception as e:
                logging.debug(f"Failed to send transaction to peer {peer}: {e}")
        
        logging.info(f"Broadcast transaction to {broadcast_count} peers")
        return broadcast_count
    
    def _send_transaction_to_peer(self, peer: str, transaction: Any) -> bool:
        """
        Send a transaction to a peer.
        
        Args:
            peer: Peer address
            transaction: Transaction to send
            
        Returns:
            True if successful, False otherwise
        """
        # This would use network API to send transaction
        # For example: POST http://{peer}/api/transactions
        # Implement actual network request here
        return False
    
    def get_node_status(self) -> Dict[str, Any]:
        """
        Get current node status.
        
        Returns:
            Dictionary with node status information
        """
        # Calculate blockchain height
        height = 0
        if self.blockchain:
            if hasattr(self.blockchain, 'chain'):
                height = len(self.blockchain.chain)
            elif hasattr(self.blockchain, 'height'):
                height = self.blockchain.height
                
        # Get consensus status
        consensus_phase = "unknown"
        if self.consensus:
            round_state = self.consensus.get_round_state()
            consensus_phase = round_state.get('phase', 'unknown')
            
        return {
            'node_id': self.config.get('node_id', ''),
            'network': self.config.get('network', 'unknown'),
            'blockchain_height': height,
            'peers_count': len(self.peers),
            'active_peers_count': len(self.active_peers),
            'pending_transactions': len(self.pending_transactions),
            'is_mining': self.is_mining,
            'is_syncing': self.is_syncing,
            'consensus_phase': consensus_phase,
            'uptime': int(time.time()) - getattr(self, 'start_time', int(time.time())),
            'fork_count': self.fork_count
        }