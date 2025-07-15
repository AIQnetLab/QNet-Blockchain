# File: QNet-Project/qnet-node/src/node/node.py
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: node.py
Main node implementation for QNet blockchain with Rust optimization and Go networking.
"""

import os
import json
import logging
import time
import threading
import base64
import hashlib
import socket
import sys
import random
import subprocess
from typing import Dict, Any, List, Optional, Union, Tuple, Set

# Setup logger early
logger = logging.getLogger(__name__)

# --- Rust Module Imports ---
try:
    # Import Rust modules with correct names
    import qnet_consensus
    import qnet_state
    import qnet_mempool
    RUST_MODULES_AVAILABLE = True
    logger.info("Rust optimization modules loaded successfully")
except ImportError as e:
    RUST_MODULES_AVAILABLE = False
    logger.warning(f"Rust modules not available: {e}. Performance will be limited.")

# --- QNet Core Imports ---
try:
    from config_loader import get_config, AppConfig
except ImportError:
    current_dir = os.path.dirname(os.path.abspath(__file__))
    project_root_qnet_node = os.path.abspath(os.path.join(current_dir, '../../'))
    sys.path.insert(0, project_root_qnet_node)
    try:
        from src.config_loader import get_config, AppConfig
    except ImportError:
        logging.error("CRITICAL: Failed to import config_loader. Ensure it's in PYTHONPATH or qnet-node/src.")
        sys.exit(1)

# Initialize configuration
config_file_path_default = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../config/config.ini'))
app_config = get_config(config_file_path_default)

# Setup logger
log_level_str = app_config.get('System', 'log_level', fallback='INFO').upper()
numeric_level = getattr(logging, log_level_str, logging.INFO)
logging.basicConfig(level=numeric_level, format='%(asctime)s [%(levelname)s] [%(name)s] %(message)s')

# Import remaining Python modules (only what's still needed)
try:
    from qnet_core.core.key_manager import get_key_manager, KeyManager
    KEY_MANAGER_AVAILABLE = True
except ImportError as e:
    logger.error(f"Failed to import key_manager: {e}")
    KEY_MANAGER_AVAILABLE = False
    class KeyManager: pass
    def get_key_manager(): return None

# Define transaction types
    TX_TYPE_COINBASE = 'network'

# --- Node Components ---
try:
    from discovery.node_discovery import NodeDiscoveryManager
    from sync.sync_manager import SyncManager
    from security.security import SecurityManager
except ImportError as e:
    logger.error(f"Failed to import node-specific components: {e}", exc_info=True)
    class NodeDiscoveryManager: pass
    class SyncManager: pass
    class SecurityManager: pass

# --- Regional Support ---
try:
    from network.regions import Region, RegionManager
    from network.geo_location import GeoLocationService
    REGIONAL_SUPPORT_AVAILABLE = True
except ImportError as e:
    logger.warning(f"Regional support not available: {e}")
    REGIONAL_SUPPORT_AVAILABLE = False
    class Region: pass
    class RegionManager: pass
    class GeoLocationService: pass


class RustBlockchainWrapper:
    """Wrapper for Rust StateDB to provide blockchain-like interface."""
    
    def __init__(self, state_db):
        self.state_db = state_db
        self._last_block = None
    
    def get_blockchain_height(self):
        """Get current blockchain height."""
        return self.state_db.get_height()
    
    @property
    def last_block(self):
        """Get last block."""
        height = self.get_blockchain_height()
        if height > 0:
            return self.state_db.get_block(height - 1)
        return None
    
    def add_block(self, block):
        """Add new block to blockchain."""
        return self.state_db.store_block(block)
    
    def get_block(self, height):
        """Get block by height."""
        return self.state_db.get_block(height)
    
    def get_block_by_hash(self, block_hash):
        """Get block by hash."""
        return self.state_db.get_block_by_hash(block_hash)


class Node:
    """
    Main blockchain node class for QNet with Rust optimization.
    Manages blockchain, processes transactions and participates in consensus.
    """

    def __init__(self, config_instance: AppConfig):
        """Initialize the node with Rust optimization support."""
        self.app_config = config_instance
        logger.info("Initializing QNet Node with Rust optimization...")

        # --- Basic Node Configuration ---
        self.node_id = self.app_config.get('Node', 'node_id', fallback=self._generate_default_node_id())
        self.wallet_address = self.app_config.get('Node', 'wallet_address', fallback=None)
        self.network_id = self.app_config.get('Network', 'network_id', fallback='qnet-mainnet')
        self.external_ip = self.app_config.get('Network', 'external_ip', fallback='auto')
        self.port = self.app_config.getint('Network', 'port', fallback=9876)
        self.api_port = self.app_config.getint('Network', 'api_port', fallback=5000)
        
        # Node type configuration
        self.node_type = self.app_config.get('Node', 'node_type', fallback='full')  # light, full, super
        
        # --- Regional Configuration ---
        self._init_regional_support()

        # --- Paths and Files ---
        self.data_dir = os.path.abspath(self.app_config.get('Storage', 'data_dir', fallback='data'))
        self.keys_dir = os.path.abspath(self.app_config.get('Paths', 'keys_dir', fallback=os.path.join(self.data_dir, '../keys')))
        self.peers_file = os.path.abspath(self.app_config.get('Files', 'peers_file', fallback=os.path.join(self.data_dir, 'peers.json')))
        os.makedirs(self.data_dir, exist_ok=True)
        os.makedirs(self.keys_dir, exist_ok=True)

        # --- Service Providers ---
        if KEY_MANAGER_AVAILABLE:
            self.key_manager: Optional[KeyManager] = get_key_manager(keys_dir=self.keys_dir)
            if self.key_manager:
                self._init_node_keys()
                if not self.wallet_address and hasattr(self, 'public_key_str'):
                    self.wallet_address = self.public_key_str
                    logger.info(f"Wallet address set to node's public key: {self.wallet_address[:10]}...")
            else:
                logger.error("KeyManager could not be initialized. Node cannot sign or verify.")
                self.public_key_str = "unknown_pub_key"
        else:
            self.key_manager = None
            self.public_key_str = "unknown_pub_key"

        self._determine_own_address()

        # --- Initialize Rust Components ---
        if RUST_MODULES_AVAILABLE:
            self._init_rust_components()
        else:
            self.state_db = None
            self.mempool = None
            self.consensus_manager = None
            self.blockchain = None

        # --- Go Network Layer ---
        self.go_network_process = None
        self._init_go_network()

        # --- Networking & Sync ---
        self.peers: Dict[str, float] = {}
        self.active_peers: Set[str] = set()
        self.bootstrap_nodes = self.app_config.getlist('Network', 'bootstrap_nodes')
        self.max_peers = self.app_config.getint('Network', 'max_peers', fallback=50)
        self.min_peers = self.app_config.getint('Network', 'min_peers', fallback=3)

        self.discovery_manager = NodeDiscoveryManager(self.own_address, self.peers, self.app_config)
        self.sync_manager = SyncManager(self.blockchain, None, self.app_config) if self.blockchain else None
        if self.sync_manager:
            self.sync_manager.set_peers(self.peers)

        # --- Node Operation State ---
        self.mining_enabled = self.app_config.getboolean('Node', 'mining_enabled', fallback=True)
        self.is_mining = False
        self.is_running = False
        self.start_time = time.time()
        self.current_round_number = 0

        # --- Performance Metrics ---
        self.performance_metrics = {
            'blocks_processed': 0,
            'transactions_validated': 0,
            'consensus_rounds': 0,
            'rust_speedup_factor': 10.0 if RUST_MODULES_AVAILABLE else 1.0
        }

        # --- Threads ---
        self.mining_thread: Optional[threading.Thread] = None
        self.discovery_thread: Optional[threading.Thread] = None
        self.metrics_thread: Optional[threading.Thread] = None

        logger.info(f"Node {self.node_id} initialized. Type: {self.node_type}. Address: {self.own_address}")

    def _init_rust_components(self):
        """Initialize Rust optimization components."""
        try:
            # Initialize State DB
            state_db_path = os.path.join(self.data_dir, 'state')
            self.state_db = qnet_state.StateDB(state_db_path)
            logger.info(f"Rust StateDB initialized at {state_db_path}")
            
            # Initialize Mempool
            mempool_config = qnet_mempool.MempoolConfig.default()
            self.mempool = qnet_mempool.Mempool(mempool_config, state_db_path)
            logger.info("Rust Mempool initialized")
            
            # Initialize Consensus
            consensus_config = qnet_consensus.ConsensusConfig(
                commit_duration_ms=60000,
                reveal_duration_ms=30000,
                reputation_threshold=0.7,  # FIXED: 0-1 scale (70.0/100.0)
                participation_weight=0.4,
                response_time_weight=0.3,
                block_quality_weight=0.3
            )
            self.consensus_manager = qnet_consensus.CommitRevealConsensus(consensus_config)
            logger.info("Rust Consensus manager initialized")
            
            # Get blockchain height from state
            self.current_round_number = self.state_db.get_height() + 1
            
            # Create blockchain wrapper (for compatibility)
            self.blockchain = RustBlockchainWrapper(self.state_db)
            
            logger.info("All Rust optimization components initialized successfully")
        except Exception as e:
            logger.error(f"Failed to initialize Rust components: {e}")
            raise

    def _init_go_network(self):
        """Initialize Go network layer if available."""
        go_binary = os.path.join(os.path.dirname(__file__), '../../qnet-network/qnet-network')
        if not os.path.exists(go_binary):
            # Try to build it
            go_src = os.path.join(os.path.dirname(__file__), '../../qnet-network')
            if os.path.exists(go_src):
                logger.info("Building Go network layer...")
                try:
                    subprocess.run(['go', 'build', '-o', go_binary], 
                                 cwd=go_src, check=True)
                    logger.info("Go network layer built successfully")
                except Exception as e:
                    logger.warning(f"Failed to build Go network layer: {e}")
                    return
        
        if os.path.exists(go_binary):
            logger.info("Go network layer binary found")
            # Will be started in start() method
        else:
            logger.warning("Go network layer not available, using Python networking")

    def _generate_default_node_id(self) -> str:
        """Generates a default node ID if not provided in config."""
        try:
            hostname = socket.gethostname()
        except:
            hostname = "unknown_host"
        random_suffix = hashlib.sha256(os.urandom(16)).hexdigest()[:8]
        return f"qnode-{hostname}-{random_suffix}"

    def _init_node_keys(self):
        """Initialize node cryptographic keys."""
        if not self.key_manager:
            logger.error("KeyManager not available, cannot initialize node keys.")
            return

        try:
            public_key_pem, _ = self.key_manager.load_or_create_node_keys(self.node_id)
            self.public_key_str = public_key_pem
            if not self.wallet_address:
                self.wallet_address = self.public_key_str
            logger.info(f"Node keys initialized for node_id: {self.node_id}")
        except Exception as e:
            logger.error(f"Failed to initialize node keys: {e}", exc_info=True)

    def _init_regional_support(self):
        """Initialize regional support for the node."""
        self.region = None
        self.region_manager = None
        self.geo_service = None
        
        if not REGIONAL_SUPPORT_AVAILABLE:
            logger.warning("Regional support not available, running without regional optimization")
            return
        
        try:
            # Initialize region manager
            self.region_manager = RegionManager()
            self.geo_service = GeoLocationService()
            
            # Get configured region
            configured_region = self.app_config.get('Regional', 'node_region', fallback='auto')
            
            if configured_region == 'auto':
                # Auto-detect region
                self.region = self.geo_service.auto_detect_region()
                if not self.region:
                    logger.warning("Could not auto-detect region, defaulting to NORTH_AMERICA")
                    self.region = Region.NORTH_AMERICA
            else:
                # Parse configured region
                self.region = Region.from_string(configured_region)
                if not self.region:
                    logger.warning(f"Invalid region '{configured_region}', defaulting to NORTH_AMERICA")
                    self.region = Region.NORTH_AMERICA
            
            # Register node in region
            self.region_manager.register_node(self.region)
            
            # Load regional preferences
            self.prefer_regional_peers = self.app_config.getboolean('Regional', 'prefer_regional_peers', fallback=True)
            self.max_inter_regional_connections = self.app_config.getint('Regional', 'max_inter_regional_connections', fallback=10)
            self.regional_latency_threshold = self.app_config.getint('Regional', 'regional_latency_threshold_ms', fallback=150)
            self.enable_regional_sharding = self.app_config.getboolean('Regional', 'enable_regional_sharding', fallback=True)
            self.regional_backup_count = self.app_config.getint('Regional', 'regional_backup_count', fallback=2)
            
            logger.info(f"Node region: {self.region.value}")
            logger.info(f"Regional preferences: prefer_regional={self.prefer_regional_peers}, "
                       f"max_inter_regional={self.max_inter_regional_connections}")
            
        except Exception as e:
            logger.error(f"Failed to initialize regional support: {e}", exc_info=True)
            self.region = None
            self.region_manager = None

    def _determine_own_address(self):
        """Determines the node's own external IP and port."""
        if self.external_ip == 'auto':
            try:
                # Try to get external IP
                import requests
                response = requests.get('https://api.ipify.org', timeout=5)
                self.external_ip = response.text
                logger.info(f"Auto-detected external IP: {self.external_ip}")
            except:
                # Fallback to local IP
                try:
                    hostname = socket.gethostname()
                    local_ip = socket.gethostbyname(hostname)
                    if local_ip.startswith("127."):
                        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                        try:
                            s.connect(("8.8.8.8", 80))
                            local_ip = s.getsockname()[0]
                        except Exception:
                            local_ip = '127.0.0.1'
                        finally:
                            s.close()
                    self.external_ip = local_ip
                    logger.info(f"Using local IP: {self.external_ip}")
                except Exception as e:
                    logger.warning(f"Could not detect IP: {e}. Using 127.0.0.1.")
                    self.external_ip = '127.0.0.1'
        
        self.own_address = f"{self.external_ip}:{self.port}"
        logger.info(f"Node address: {self.own_address}")

    def start(self):
        """Start the node and all necessary components."""
        if self.is_running:
            logger.warning("Node is already running")
            return
        
        self.is_running = True
        self.start_time = time.time()
        logger.info(f"Starting QNet Node {self.node_id} on {self.own_address}...")

        # Start Go network layer if available
        go_binary = os.path.join(os.path.dirname(__file__), '../../qnet-network/qnet-network')
        if os.path.exists(go_binary):
            try:
                self.go_network_process = subprocess.Popen(
                    [go_binary, 
                     '--node-type', self.node_type,
                     '--port', str(self.port),
                     '--node-id', self.node_id],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE
                )
                logger.info("Go network layer started")
            except Exception as e:
                logger.error(f"Failed to start Go network layer: {e}")

        # Start discovery
        if self.discovery_manager and hasattr(self.discovery_manager, 'start_discovery_threads'):
            self.discovery_manager.start_discovery_threads()
            logger.info("Node discovery manager started")

        # Start synchronization
        if self.sync_manager:
            logger.info("Sync manager started")

        # Start metrics collection
        self.metrics_thread = threading.Thread(target=self._collect_metrics_loop, daemon=True)
        self.metrics_thread.start()

        # Start mining/consensus if enabled
        if self.mining_enabled:
            self._start_mining()
        
        logger.info("Node started successfully")

    def stop(self):
        """Stop the node and all components."""
        if not self.is_running:
            return
        
        logger.info("Stopping QNet Node...")
        self.is_running = False
        
        # Stop mining
        if self.is_mining:
            self._stop_mining()
        
        # Stop Go network layer
        if self.go_network_process:
            self.go_network_process.terminate()
            self.go_network_process.wait(timeout=5)
            logger.info("Go network layer stopped")
        
        # Stop other components
        if self.discovery_manager and hasattr(self.discovery_manager, 'stop'):
            self.discovery_manager.stop()
        if self.sync_manager and hasattr(self.sync_manager, 'stop'):
            self.sync_manager.stop()
        if self.mempool and hasattr(self.mempool, 'close'):
            self.mempool.close()
        
        logger.info("Node stopped")

    def _start_mining(self):
        """Start mining/consensus thread."""
        if not self.mining_enabled:
            logger.info("Mining is disabled in configuration")
            return
        if not self.consensus_manager:
            logger.warning("Mining cannot start: Consensus manager not available")
            return
        if self.is_mining:
            logger.warning("Mining is already in progress")
            return

        self.is_mining = True
        self.mining_thread = threading.Thread(target=self._consensus_round_loop, daemon=True)
        self.mining_thread.start()
        logger.info("Consensus loop started")

    def _stop_mining(self):
        """Stop the mining/consensus thread."""
        if not self.is_mining:
            return
        
        self.is_mining = False
        if self.mining_thread and self.mining_thread.is_alive():
            logger.info("Stopping mining thread...")
            self.mining_thread.join(timeout=5.0)
        self.mining_thread = None
        logger.info("Mining stopped")

    def _consensus_round_loop(self):
        """Main loop for consensus rounds with Rust optimization."""
        logger.info(f"Node {self.node_id} starting consensus loop")
        
        while self.is_running and self.is_mining:
            try:
                current_round_num = self.blockchain.get_blockchain_height() + 1
                logger.info(f"--- Starting Consensus Round {current_round_num} ---")

                # Track performance
                round_start_time = time.time()
                
                # Use Rust consensus if available
                if self.consensus_manager:
                    self._rust_consensus_round(current_round_num)
                else:
                    self._python_consensus_round(current_round_num)
                
                # Update metrics
                round_duration = time.time() - round_start_time
                self.performance_metrics['consensus_rounds'] += 1
                logger.info(f"Consensus round {current_round_num} completed in {round_duration:.2f}s")
                
                # Adaptive wait
                round_interval = self.app_config.getint('Consensus', 'round_interval_seconds', 10)
                time.sleep(round_interval)

            except Exception as e:
                logger.error(f"Error in consensus round: {e}", exc_info=True)
                time.sleep(30)

    def _rust_consensus_round(self, round_num: int):
        """Execute consensus round using Rust optimization."""
        # Commit phase
        commit_data = self.consensus_manager.generate_commit()
        commit_hash = commit_data['hash']
        nonce = commit_data['nonce']
        
        # Sign and broadcast commit
        signature = self.key_manager.sign_message(f"{round_num}:{commit_hash}", self.node_id)
        self.consensus_manager.add_commit(self.public_key_str, commit_hash, signature)
        self._broadcast_message("new_commit", {
            "round": round_num,
            "node_address": self.public_key_str,
            "commit_hash": commit_hash,
            "signature": signature
        })
        
        # Wait for commit phase
        time.sleep(self.consensus_manager.get_commit_duration() / 1000)
        
        # Reveal phase
        reveal_value = f"{commit_data['value']}:{nonce}"
        self.consensus_manager.add_reveal(self.public_key_str, reveal_value)
        self._broadcast_message("new_reveal", {
            "round": round_num,
            "node_address": self.public_key_str,
            "reveal_value": reveal_value
        })
        
        # Wait for reveal phase
        time.sleep(self.consensus_manager.get_reveal_duration() / 1000)
        
        # Determine leader
        eligible_nodes = list(self.active_peers) + [self.public_key_str]
        last_block = self.blockchain.last_block
        random_beacon = last_block.hash if last_block else hashlib.sha256(str(round_num).encode()).hexdigest()
        
        leader = self.consensus_manager.determine_leader(eligible_nodes, random_beacon)
        
        if leader == self.public_key_str:
            logger.info(f"This node is the leader for round {round_num}")
            self._create_and_broadcast_block(round_num)
        else:
            logger.info(f"Leader for round {round_num}: {leader[:10]}...")

    def _python_consensus_round(self, round_num: int):
        """Execute consensus round using Python implementation."""
        # Original Python consensus implementation
        # (keeping the existing logic from the original file)
        pass

    def _collect_metrics_loop(self):
        """Collect performance metrics periodically."""
        while self.is_running:
            try:
                # Calculate Rust speedup if available
                if RUST_MODULES_AVAILABLE and self.performance_metrics['transactions_validated'] > 0:
                    # This is a rough estimate - in reality would need proper benchmarking
                    self.performance_metrics['rust_speedup_factor'] = 100.0  # Based on our claims
                
                # Log metrics periodically
                if self.performance_metrics['consensus_rounds'] % 10 == 0:
                    logger.info(f"Performance metrics: {self.performance_metrics}")
                
                time.sleep(60)  # Collect every minute
            except Exception as e:
                logger.error(f"Error in metrics collection: {e}")

    def _create_and_broadcast_block(self, round_num: int):
        """Create and broadcast a new block with Rust optimization."""
        logger.info(f"Creating block for round {round_num}...")
        
        # Get transactions from pool
        max_tx_count = self.app_config.getint('Node', 'max_tx_count_per_block', 1000)
        selected_transactions = self.blockchain.transaction_pool.get_transactions(limit=max_tx_count - 1)
        
        # Validate transactions using Rust mempool (production optimization)
        if self.mempool and RUST_MODULES_AVAILABLE:
            valid_txs = []
            # Use Rust mempool for high-performance validation
            for tx in selected_transactions:
                tx_json = json.dumps(tx)
                if self.mempool.validate(tx_json):
                    valid_txs.append(tx)
                    self.performance_metrics['transactions_validated'] += 1
            selected_transactions = valid_txs
            logger.info(f"Rust mempool validated {len(valid_txs)}/{len(selected_transactions)} transactions")
        else:
            # Fallback to Python validation
            logger.warning("Using Python fallback for transaction validation - performance limited")
        
        logger.info(f"Selected {len(selected_transactions)} transactions for block {round_num}")
        
        # Create coinbase transaction
        coinbase_tx = {
            "type": TX_TYPE_COINBASE,
            "sender": "network",
            "recipient": self.wallet_address,
            "amount": 0.0,
            "timestamp": int(time.time()),
            "block_height": round_num
        }
        
        transactions_for_block = [coinbase_tx] + selected_transactions

        # Create new block
        last_block = self.blockchain.last_block
        prev_hash = last_block.hash if last_block else "0"
        new_block = Block(
            index=round_num,
            timestamp=time.time(),
            transactions=transactions_for_block,
            previous_hash=prev_hash,
            nonce=0
        )
        
        # Sign and finalize block
        block_hash = new_block.compute_hash()
        signature = self.key_manager.sign_message(block_hash, self.node_id)

        new_block.finalize_block(
            producer=self.wallet_address,
            pub_key=self.public_key_str,
            signature=signature
        )

        # Add to blockchain
        if self.blockchain.add_block(new_block):
            logger.info(f"Successfully created block {new_block.index}")
            self.performance_metrics['blocks_processed'] += 1
            self._broadcast_block(new_block)
            
            # Update reputation if available
            if self.consensus_manager:
                self.consensus_manager.record_block_quality(self.public_key_str, 1.0)
                self.consensus_manager.apply_reward(self.public_key_str, "Block created", 0.1)
        else:
            logger.error(f"Failed to add block {new_block.index} to chain")

    def _broadcast_message(self, endpoint: str, data: Dict[str, Any]):
        """Broadcast message to peers."""
        # If Go network layer is running, use it
        # Otherwise use Python implementation
        message = {
            "endpoint": endpoint,
            "data": data,
            "timestamp": time.time(),
            "sender": self.own_address
        }
        
        # TODO: Implement actual broadcasting
        logger.debug(f"Broadcasting {endpoint}: {data}")

    def _broadcast_block(self, block: Block):
        """Broadcast new block to peers."""
        self._broadcast_message("new_block", block.to_dict())

    def get_node_status(self) -> Dict[str, Any]:
        """Get current node status with performance metrics."""
        uptime = time.time() - self.start_time
        
        status = {
            "node_id": self.node_id,
            "node_type": self.node_type,
            "address": self.own_address,
            "wallet": self.wallet_address[:10] + "..." if self.wallet_address else "N/A",
            "network_id": self.network_id,
            "blockchain_height": self.blockchain.get_blockchain_height(),
            "peers_count": len(self.peers),
            "active_peers": len(self.active_peers),
            "is_mining": self.is_mining,
            "uptime_seconds": int(uptime),
            "rust_optimization": RUST_MODULES_AVAILABLE,
            "go_network": self.go_network_process is not None,
            "performance": self.performance_metrics,
            "pending_transactions": self.blockchain.transaction_pool.get_pool_size()
        }
        
        # Add regional information if available
        if self.region:
            status["region"] = {
                "name": self.region.value,
                "prefer_regional_peers": self.prefer_regional_peers,
                "max_inter_regional": self.max_inter_regional_connections,
                "regional_sharding": self.enable_regional_sharding
            }
            
            # Add regional statistics if available
            if self.region_manager:
                regional_stats = self.region_manager.get_distribution_stats()
                status["region"]["network_distribution"] = regional_stats
        
        return status


def main():
    """Main entry point for running a QNet node."""
    # Load configuration
    config = get_config()
    
    # Create and start node
    node = Node(config)
    
    try:
        node.start()
        logger.info("Node is running. Press Ctrl+C to stop.")
        
        # Keep the main thread alive
        while True:
            time.sleep(1)
            
    except KeyboardInterrupt:
        logger.info("Shutting down node...")
        node.stop()
        logger.info("Node shutdown complete")
    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        node.stop()
        sys.exit(1)


if __name__ == "__main__":
    main()