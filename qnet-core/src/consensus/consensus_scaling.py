#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: consensus_scaling.py
Integrates all consensus scaling improvements into the QNet blockchain
"""

import logging
import threading
import time
import os
import sys
import json
import random
import hashlib
import requests
from typing import Dict, List, Set, Tuple, Optional, Any, Union, Type

# Import core modules
# Note: These should be imported when integrated with the real system
# For standalone testing, we'll handle import errors gracefully
try:
    from dynamic_consensus import NetworkMetrics, AdaptiveConsensusTimer
    from network_partition_manager import NetworkPartitionManager
    from reputation_consensus import NodeReputation, ReputationConsensusManager
    MODULES_AVAILABLE = True
except ImportError:
    logging.warning("Could not import consensus scaling modules. Running in compatibility mode.")
    MODULES_AVAILABLE = False

class ConsensusScalingManager:
    """
    Integrates and manages all consensus scaling improvements
    """
    def __init__(self, own_address: str, blockchain: Any, config: Any, app: Any = None):
        """
        Initialize the consensus scaling manager
        
        Args:
            own_address: Address of this node
            blockchain: Reference to the blockchain object
            config: Configuration object
            app: Flask application (optional)
        """
        if not own_address or not isinstance(own_address, str):
            raise ValueError("Invalid own_address")
            
        if not blockchain:
            raise ValueError("Invalid blockchain object")
            
        if not config:
            raise ValueError("Invalid configuration object")
            
        self.own_address = own_address
        self.blockchain = blockchain
        self.config = config
        self.app = app
        
        # Check if required modules are available
        if not MODULES_AVAILABLE:
            logging.warning("Consensus scaling modules not available. Running in compatibility mode.")
            self.active = False
            return
        
        # Initialize network metrics
        self.network_metrics = NetworkMetrics()
        
        # Initialize adaptive timer
        self.consensus_timer = AdaptiveConsensusTimer(self.network_metrics, config)
        
        # Initialize reputation system
        self.reputation_manager = NodeReputation(own_address, config)
        
        # Initialize reputation-based consensus
        self.reputation_consensus = ReputationConsensusManager(
            own_address, self.reputation_manager, config
        )
        
        # Initialize network partition manager
        self.partition_manager = NetworkPartitionManager(
            own_address, blockchain, config
        )
        
        # Internal state
        self.active = False
        self.monitor_threads = []
        
        # Function references for original methods that we'll enhance
        self.original_compute_proposal = None
        self.original_broadcast_to_peers = None
        self.original_distribute_reward = None
        
        logging.info("Consensus scaling manager initialized")
    
    def start(self) -> None:
        """
        Start all consensus scaling systems
        """
        if self.active or not MODULES_AVAILABLE:
            return
        
        logging.info("Starting consensus scaling systems")
        self.active = True
        
        try:
            # Start network metrics collection
            peers = self._get_current_peers()
            monitor_thread = self.consensus_timer.start_monitoring(peers)
            self.monitor_threads.append(monitor_thread)
            
            # Start network partition detection
            partition_thread = self.partition_manager.start_monitoring()
            self.monitor_threads.append(partition_thread)
            
            # Register API endpoints if app is provided
            if self.app:
                self._register_api_endpoints()
            
            logging.info("Consensus scaling systems started")
        except Exception as e:
            logging.error(f"Error starting consensus scaling systems: {e}")
            self.active = False
            raise
    
    def _get_current_peers(self) -> List[str]:
        """Get the current list of peers from the config"""
        try:
            if hasattr(self.config, 'peers') and isinstance(self.config.peers, dict):
                return list(self.config.peers.keys())
            else:
                logging.warning("Config has no peers attribute or it's not a dictionary")
                return []
        except Exception as e:
            logging.error(f"Error getting peers: {e}")
            return []
    
    def _register_api_endpoints(self) -> None:
        """
        Register API endpoints for monitoring and configuration
        """
        if not self.app:
            logging.warning("No Flask app provided, cannot register endpoints")
            return
            
        try:
            @self.app.route('/api/v1/consensus/stats')
            def consensus_stats_endpoint():
                stats = self.get_consensus_stats()
                return json.dumps(stats), 200, {'Content-Type': 'application/json'}
            
            @self.app.route('/api/v1/consensus/reputation')
            def reputation_endpoint():
                report = self.reputation_consensus.get_reputation_report()
                return json.dumps(report), 200, {'Content-Type': 'application/json'}
            
            @self.app.route('/api/v1/network/health')
            def network_health_endpoint():
                health_report = self.partition_manager.get_network_health_report()
                return json.dumps(health_report), 200, {'Content-Type': 'application/json'}
            
            logging.info("Registered consensus scaling API endpoints")
        except Exception as e:
            logging.error(f"Error registering API endpoints: {e}")
    
    def get_consensus_stats(self) -> Dict[str, Any]:
        """
        Get comprehensive statistics on consensus performance
        
        Returns:
            Dictionary with consensus statistics
        """
        if not self.active or not MODULES_AVAILABLE:
            return {"error": "Consensus scaling not active"}
            
        try:
            # Get current blockchain round
            current_round = len(self.blockchain.chain)
            
            # Get network metrics
            network_metrics = {
                "average_latency": self.network_metrics.average_latency,
                "latency_std_dev": self.network_metrics.latency_std_dev,
                "network_reliability": self.network_metrics.network_reliability,
                "p90_latency": self.network_metrics.p90_latency
            }
            
            # Get consensus timing
            commit_time, commit_offset = self.consensus_timer.get_commit_wait_time()
            reveal_time, reveal_offset = self.consensus_timer.get_reveal_wait_time()
            
            consensus_timing = {
                "commit_base_time": commit_time,
                "commit_offset": commit_offset,
                "reveal_base_time": reveal_time,
                "reveal_offset": reveal_offset
            }
            
            # Get reputation stats
            reputation_stats = self.reputation_consensus.get_reputation_report()
            
            # Get network health
            network_health = self.partition_manager.get_network_health_report()
            
            # Get active peers count
            active_nodes = len(self._get_current_peers())
            
            return {
                "current_round": current_round,
                "network_metrics": network_metrics,
                "consensus_timing": consensus_timing,
                "reputation_stats": reputation_stats,
                "network_health": network_health,
                "active_nodes": active_nodes,
                "timestamp": time.time()
            }
        except Exception as e:
            logging.error(f"Error getting consensus stats: {e}")
            return {"error": str(e), "timestamp": time.time()}
    
    def update_consensus_parameters(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """
        Update configurable consensus parameters
        
        Args:
            params: Dictionary with parameters to update
            
        Returns:
            Dictionary with update status for each parameter
        """
        if not self.active or not MODULES_AVAILABLE:
            return {"error": "Consensus scaling not active"}
            
        results = {}
        
        try:
            if "reputation_influence" in params:
                try:
                    value = float(params["reputation_influence"])
                    if 0.0 <= value <= 1.0:
                        self.reputation_consensus.reputation_influence = value
                        results["reputation_influence"] = "updated"
                    else:
                        results["reputation_influence"] = "error: value must be between 0.0 and 1.0"
                except (ValueError, TypeError) as e:
                    results["reputation_influence"] = f"error: {str(e)}"
            
            if "min_reveals" in params:
                try:
                    value = int(params["min_reveals"])
                    if value >= 1:
                        self.reputation_consensus.min_reveals = value
                        results["min_reveals"] = "updated"
                    else:
                        results["min_reveals"] = "error: value must be at least 1"
                except (ValueError, TypeError) as e:
                    results["min_reveals"] = f"error: {str(e)}"
            
            if "safety_factor" in params:
                try:
                    value = float(params["safety_factor"])
                    if value >= 1.0:
                        self.consensus_timer.safety_factor = value
                        results["safety_factor"] = "updated"
                    else:
                        results["safety_factor"] = "error: value must be at least 1.0"
                except (ValueError, TypeError) as e:
                    results["safety_factor"] = f"error: {str(e)}"
                    
            if "detection_interval" in params:
                try:
                    value = int(params["detection_interval"])
                    if value >= 60:
                        self.partition_manager.detection_interval = value
                        results["detection_interval"] = "updated"
                    else:
                        results["detection_interval"] = "error: value must be at least 60 seconds"
                except (ValueError, TypeError) as e:
                    results["detection_interval"] = f"error: {str(e)}"
                    
            if "recovery_cooldown" in params:
                try:
                    value = int(params["recovery_cooldown"])
                    if value >= 60:
                        self.partition_manager.recovery_cooldown = value
                        results["recovery_cooldown"] = "updated"
                    else:
                        results["recovery_cooldown"] = "error: value must be at least 60 seconds"
                except (ValueError, TypeError) as e:
                    results["recovery_cooldown"] = f"error: {str(e)}"
            
            # Save updated parameters to config.ini if possible
            self._save_parameters_to_config()
            
        except Exception as e:
            logging.error(f"Error updating consensus parameters: {e}")
            results["error"] = str(e)
        
        return results
    
    def _save_parameters_to_config(self) -> bool:
        """
        Save updated parameters to config.ini
        
        Returns:
            True if successful, False otherwise
        """
        try:
            # Check if ConfigParser available
            import configparser
            
            # Try to load existing config
            config_file = 'config.ini'
            if hasattr(self.config, 'config_file'):
                config_file = self.config.config_file
                
            parser = configparser.ConfigParser()
            if os.path.exists(config_file):
                parser.read(config_file)
                
            # Ensure the EnhancedConsensus section exists
            if 'EnhancedConsensus' not in parser:
                parser['EnhancedConsensus'] = {}
                
            # Update values
            parser['EnhancedConsensus']['reputation_influence'] = str(self.reputation_consensus.reputation_influence)
            parser['EnhancedConsensus']['min_reveals'] = str(self.reputation_consensus.min_reveals)
            parser['EnhancedConsensus']['safety_factor'] = str(self.consensus_timer.safety_factor)
            parser['EnhancedConsensus']['detection_interval'] = str(self.partition_manager.detection_interval)
            parser['EnhancedConsensus']['recovery_cooldown'] = str(self.partition_manager.recovery_cooldown)
            
            # Write the updated config back to file
            with open(config_file, 'w') as f:
                parser.write(f)
                
            logging.info(f"Updated consensus parameters saved to {config_file}")
            return True
        except Exception as e:
            logging.error(f"Error saving parameters to config: {e}")
            return False
    
    def integrate_with_mining(self, auto_mine_function):
        """
        Create a wrapper around the auto_mine function to integrate consensus improvements
        
        Args:
            auto_mine_function: Original auto_mine function
            
        Returns:
            Enhanced auto_mine function
        """
        # Save references to required functions if they exist in the global scope
        try:
            # Look for compute_proposal in globals or in consensus module
            if 'compute_proposal' in globals():
                self.original_compute_proposal = globals()['compute_proposal']
            elif hasattr(self.config, 'compute_proposal'):
                self.original_compute_proposal = self.config.compute_proposal
                
            # Look for broadcast_to_peers
            if 'broadcast_to_peers' in globals():
                self.original_broadcast_to_peers = globals()['broadcast_to_peers']
                
            # Look for distribute_reward
            if 'distribute_reward' in globals():
                self.original_distribute_reward = globals()['distribute_reward']
                
        except Exception as e:
            logging.error(f"Error acquiring function references: {e}")
        
        def enhanced_auto_mine():
            # Start consensus scaling systems if not already started
            if not self.active and MODULES_AVAILABLE:
                try:
                    self.start()
                except Exception as e:
                    logging.error(f"Failed to start consensus scaling: {e}")
                    # Fall back to original auto_mine if we can't start
                    return auto_mine_function()
            
            # If not active or required modules not available, use original function
            if not self.active or not MODULES_AVAILABLE:
                logging.warning("Consensus scaling not active, using original auto_mine")
                return auto_mine_function()
            
            # Enhanced mining loop
            while True:
                try:
                    # Get current round
                    try:
                        current_round = len(self.blockchain.chain)
                    except (AttributeError, TypeError) as e:
                        logging.error(f"Error accessing blockchain chain: {e}")
                        current_round = 0
                    
                    # Sync chain before starting new round
                    try:
                        response = requests.get(f"http://{self.own_address}/sync_chain", timeout=10)
                        if response.status_code == 200:
                            data = response.json()
                            logging.info(f"Auto-sync before mining: {data}")
                    except Exception as e:
                        logging.error(f"Error syncing chain before mining: {e}")
                    
                    # Log chain lengths across peers for debugging
                    try:
                        local_length = len(self.blockchain.chain)
                        logging.info(f"Local chain length: {local_length}")
                        
                        for peer in self._get_current_peers():
                            try:
                                # Get timeout from config
                                timeout = 5
                                if hasattr(self.config, 'app_config') and hasattr(self.config.app_config, 'getint'):
                                    timeout = self.config.app_config.getint('Network', 'connection_timeout', fallback=5)
                                
                                response = requests.get(f"http://{peer}/chain", timeout=timeout)
                                if response.status_code == 200:
                                    data = response.json()
                                    peer_length = data.get("length", 0)
                                    logging.info(f"Peer {peer} chain length: {peer_length}, diff: {peer_length - local_length}")
                                    
                                    # Record peer chain info for partition detection
                                    last_block = None
                                    if "chain" in data and data["chain"]:
                                        last_block = data["chain"][-1]
                                    
                                    if last_block:
                                        self.partition_manager.record_peer_chain_info(
                                            peer,
                                            peer_length,
                                            last_block.get("hash", ""),
                                            last_block.get("timestamp", 0)
                                        )
                            except Exception as e:
                                logging.warning(f"Failed to get chain length from peer {peer}: {e}")
                    except Exception as e:
                        logging.error(f"Error checking chain lengths: {e}")
                    
                    # Update eligible nodes
                    try:
                        if hasattr(self.config, 'update_eligible_nodes'):
                            self.config.update_eligible_nodes()
                    except Exception as e:
                        logging.error(f"Error updating eligible nodes: {e}")
                    
                    # Debug logging for auto_mine start
                    try:
                        eligible_nodes = []
                        if hasattr(self.config, 'eligible_nodes'):
                            eligible_nodes = self.config.eligible_nodes
                        
                        logging.info(f"### MINING-DEBUG: Starting auto-mine for round {current_round}")
                        logging.info(f"### MINING-DEBUG: Eligible nodes: {eligible_nodes}")
                    except Exception as e:
                        logging.error(f"Error in debug logging: {e}")
                    
                    # Prepare for consensus
                    # First, ensure we have a valid secret key
                    if not hasattr(self.config, 'secret_key') or self.config.secret_key is None:
                        logging.error("Secret key is None, cannot compute proposal")
                        time.sleep(60)  # Wait before trying again
                        continue
                    
                    # Convert secret_key to string
                    secret_key_str = ""
                    try:
                        if isinstance(self.config.secret_key, bytes):
                            secret_key_str = self.config.secret_key.decode("utf-8") if hasattr(self.config.secret_key, "decode") else str(self.config.secret_key)
                        else:
                            secret_key_str = str(self.config.secret_key)
                    except Exception as e:
                        logging.error(f"Error converting secret_key to string: {e}")
                        time.sleep(60)  # Wait before trying again
                        continue
                    
                    # Perform commit phase
                    try:
                        # Compute proposal using original function or our function
                        if self.original_compute_proposal:
                            proposal = self.original_compute_proposal(current_round, secret_key_str)
                        else:
                            # Fallback implementation
                            message = secret_key_str + str(current_round)
                            proposal = hashlib.sha256(message.encode()).hexdigest()
                        
                        # Make sure proposal is a string
                        if not isinstance(proposal, str):
                            proposal = str(proposal)
                        
                        commit_value = hashlib.sha256(proposal.encode()).hexdigest()
                        
                        # Add to reputation consensus manager
                        self.reputation_consensus.add_commit(current_round, self.own_address, commit_value)
                        logging.info(f"Commit: Node {self.own_address} committed {commit_value} for round {current_round}")
                        
                        # Debug logging
                        logging.info(f"### MINING-DEBUG: Added commit {commit_value} for round {current_round}")
                        
                        # Broadcast commit to peers
                        broadcast_data = {
                            "round": current_round,
                            "node_address": self.own_address,
                            "commit_value": commit_value
                        }
                        
                        if self.original_broadcast_to_peers:
                            self.original_broadcast_to_peers("/api/v1/consensus/broadcast_commit", broadcast_data)
                        else:
                            # Fallback implementation
                            self._broadcast_to_peers("/api/v1/consensus/broadcast_commit", broadcast_data)
                    except Exception as e:
                        logging.error(f"Error in commit phase: {e}")
                        time.sleep(60)  # Wait before trying again
                        continue
                    
                    # Wait for commits with adaptive timing
                    commit_time, commit_offset = self.consensus_timer.get_commit_wait_time()
                    wait_time = commit_time + random.uniform(-commit_offset, commit_offset)
                    logging.info(f"Waiting {wait_time:.1f}s for commit phase")
                    time.sleep(wait_time)
                    
                    # Perform reveal phase
                    try:
                        # Add to reputation consensus manager
                        self.reputation_consensus.add_reveal(current_round, self.own_address, proposal)
                        logging.info(f"Reveal: Node {self.own_address} revealed {proposal} for round {current_round}")
                        
                        # Debug logging
                        logging.info(f"### MINING-DEBUG: Added reveal {proposal} for round {current_round}")
                        
                        # Broadcast reveal to peers
                        broadcast_data = {
                            "round": current_round,
                            "node_address": self.own_address,
                            "reveal_value": proposal
                        }
                        
                        if self.original_broadcast_to_peers:
                            self.original_broadcast_to_peers("/api/v1/consensus/broadcast_reveal", broadcast_data)
                        else:
                            # Fallback implementation
                            self._broadcast_to_peers("/api/v1/consensus/broadcast_reveal", broadcast_data)
                    except Exception as e:
                        logging.error(f"Error in reveal phase: {e}")
                        time.sleep(60)  # Wait before trying again
                        continue
                    
                    # Wait for reveals with adaptive timing
                    reveal_time, reveal_offset = self.consensus_timer.get_reveal_wait_time()
                    wait_time = reveal_time + random.uniform(-reveal_offset, reveal_offset)
                    logging.info(f"Waiting {wait_time:.1f}s for reveal phase")
                    time.sleep(wait_time)
                    
                    # Get the random beacon
                    try:
                        beacon = self.reputation_consensus.get_random_beacon(current_round)
                        logging.info(f"Round {current_round}: Beacon = {beacon}")
                    except Exception as e:
                        logging.error(f"Error getting random beacon: {e}")
                        time.sleep(60)  # Wait before trying again
                        continue
                    
                    # Enhanced logging
                    try:
                        logging.info(f"Commits for round {current_round}: {self.reputation_consensus.commits.get(current_round, {})}")
                        logging.info(f"Reveals for round {current_round}: {self.reputation_consensus.reveals.get(current_round, {})}")
                    except Exception as e:
                        logging.error(f"Error in logging: {e}")
                    
                    # Determine leader using reputation-based consensus
                    try:
                        # Get eligible nodes
                        eligible_nodes = []
                        if hasattr(self.config, 'eligible_nodes'):
                            eligible_nodes = self.config.eligible_nodes
                            
                        leader = self.reputation_consensus.determine_leader(
                            current_round, eligible_nodes, beacon)
                        
                        # Debug logging
                        logging.info(f"### MINING-DEBUG: Leader determination result: {leader}")
                        
                        if leader is None:
                            logging.info("No consensus reached; skipping block mining for this round.")
                            
                            # Record the consensus results before waiting
                            participating_nodes = self.reputation_consensus.node_participation.get(current_round, set())
                            commit_count = len(self.reputation_consensus.commits.get(current_round, {}))
                            reveal_count = len(self.reputation_consensus.reveals.get(current_round, {}))
                            
                            # Record phase result
                            self.consensus_timer.record_phase_result(
                                "commit", commit_time, commit_count, len(eligible_nodes) if eligible_nodes else 0)
                            self.consensus_timer.record_phase_result(
                                "reveal", reveal_time, reveal_count, len(eligible_nodes) if eligible_nodes else 0)
                            
                            # Initiate partition check
                            if self.partition_manager.detect_partition(self._get_current_peers()):
                                self.partition_manager.resolve_partition(self._get_current_peers())
                            
                            time.sleep(60)  # Wait before trying next round
                            continue
                            
                        logging.info(f"Determined leader: {leader}")
                        if leader != self.own_address:
                            logging.info(f"Auto-mine: Not leader (Leader: {leader}). Skipping block mining for round {current_round}.")
                            
                            # Record consensus results
                            participating_nodes = self.reputation_consensus.node_participation.get(current_round, set())
                            commit_count = len(self.reputation_consensus.commits.get(current_round, {}))
                            reveal_count = len(self.reputation_consensus.reveals.get(current_round, {}))
                            
                            # Record phase result
                            self.consensus_timer.record_phase_result(
                                "commit", commit_time, commit_count, len(eligible_nodes) if eligible_nodes else 0)
                            self.consensus_timer.record_phase_result(
                                "reveal", reveal_time, reveal_count, len(eligible_nodes) if eligible_nodes else 0)
                            
                            # Wait an appropriate time before the next round
                            time.sleep(120 + random.uniform(0, 30))
                            continue
                    except Exception as e:
                        logging.error(f"Error determining leader: {e}")
                        time.sleep(60)  # Wait before trying again
                        continue
                    
                    # If this node is leader, mine the block
                    try:
                        # Debug logging
                        logging.info(f"### MINING-DEBUG: Will attempt to mine block as leader: {leader == self.own_address}")
                        
                        # Record block mining start time
                        mining_start = time.time()
                        
                        # Calculate reward
                        reward = None
                        if self.original_distribute_reward:
                            reward = self.original_distribute_reward(self.own_address)
                        else:
                            # Fallback to a simple reward calculation
                            current_round = len(self.blockchain.chain)
                            reward = 16384 / (2 ** (current_round // 10))
                        
                        # Create coinbase transaction
                        coinbase_tx = {
                            "sender": "network",
                            "recipient": self.own_address,
                            "amount": reward,
                            "pub_key": self.config.public_key if hasattr(self.config, "public_key") else None
                        }
                        
                        # Get pruned_mode and max_chain_length
                        pruned_mode = False
                        max_chain_length = 1000
                        
                        if hasattr(self.config, 'app_config'):
                            if hasattr(self.config.app_config, 'get'):
                                node_mode = self.config.app_config.get('Node', 'mode', fallback='full').lower()
                                pruned_mode = False if node_mode == "full" else True
                                
                            if hasattr(self.config.app_config, 'getint'):
                                max_chain_length = self.config.app_config.getint('Node', 'max_chain_length', fallback=1000)
                        
                        # Get sign_block_hash function
                        sign_block_hash = None
                        if 'sign_block_hash' in globals():
                            sign_block_hash = globals()['sign_block_hash']
                        elif hasattr(self.config, 'sign_block_hash'):
                            sign_block_hash = self.config.sign_block_hash
                        else:
                            # Fallback implementation
                            def sign_block_hash(block_hash):
                                if isinstance(self.config.secret_key, bytes):
                                    secret_key_str = self.config.secret_key.decode('utf-8') if hasattr(self.config.secret_key, 'decode') else str(self.config.secret_key)
                                else:
                                    secret_key_str = str(self.config.secret_key)
                                
                                signature = hashlib.sha256((secret_key_str + block_hash).encode()).hexdigest()
                                return signature
                        
                        # Mine the block
                        block = self.blockchain.mine_block(
                            coinbase_tx, 
                            sign_block_hash,
                            pruned_mode=pruned_mode, 
                            max_chain_length=max_chain_length
                        )
                        
                        # Record block mining duration
                        mining_duration = time.time() - mining_start
                        
                        if block:
                            # Clear consensus data for this round
                            with self.reputation_consensus.lock:
                                self.reputation_consensus.commits.pop(current_round, None)
                                self.reputation_consensus.reveals.pop(current_round, None)
                            
                            # Update state
                            state, total = self.blockchain.compute_state()
                            if hasattr(self.config, 'balances'):
                                self.config.balances = state
                            if hasattr(self.config, 'total_issued'):
                                self.config.total_issued = total
                            
                            logging.info(f"Auto-mined block {block.index} with reward {reward} in {mining_duration:.2f}s")
                            
                            # Apply reputation reward for successful block
                            self.reputation_manager.apply_reward(
                                self.own_address, 
                                "Successfully mined block", 
                                0.2
                            )
                            
                            # Record block quality (faster is better, up to a point)
                            quality_score = max(0.1, min(1.0, 5.0 / mining_duration))
                            self.reputation_manager.record_block_quality(self.own_address, quality_score)
                        else:
                            logging.info("Auto-mine: No transactions to mine.")
                    except Exception as e:
                        logging.error(f"Error mining block: {e}")
                        
                        # Apply reputation penalty for mining failure
                        self.reputation_manager.apply_penalty(
                            self.own_address,
                            "Failed to mine block",
                            0.1
                        )
                except Exception as e:
                    logging.error(f"Error mining block: {e}")
                    
                    # Apply reputation penalty for mining failure
                    try:
                        self.reputation_manager.apply_penalty(
                            self.own_address,
                            "Exception during mining",
                            0.05
                        )
                    except Exception as e2:
                        logging.error(f"Error applying reputation penalty: {e2}")
            except Exception as e:
                logging.error(f"Error in mining round: {e}")
                time.sleep(60)  # Wait before trying again
        
        # Return the enhanced function
        return _monitor_loop
    
    def _broadcast_to_peers(self, endpoint: str, data: dict) -> None:
        """
        Broadcast data to all peers
        
        Args:
            endpoint: API endpoint to send data to
            data: Data to broadcast
        """
        # Get current peers
        peers = []
        try:
            if hasattr(self.config, 'peers'):
                peers = list(self.config.peers.keys())
        except Exception as e:
            logging.error(f"Error getting peers for broadcast: {e}")
            return
        
        if not peers:
            logging.warning("No peers to broadcast to")
            return
        
        # Limit to a subset of peers to avoid network flooding
        if len(peers) > 10:
            # Prioritize peers with higher reputation if available
            if hasattr(self, 'reputation_manager'):
                try:
                    # Get reputation scores
                    reputations = {}
                    for peer in peers:
                        reputations[peer] = self.reputation_manager.get_reputation(peer)
                    
                    # Sort by reputation
                    sorted_peers = sorted(reputations.items(), key=lambda x: x[1], reverse=True)
                    peers_to_broadcast = [peer for peer, _ in sorted_peers[:10]]
                except Exception as e:
                    logging.error(f"Error prioritizing peers by reputation: {e}")
                    peers_to_broadcast = random.sample(peers, 10)
            else:
                peers_to_broadcast = random.sample(peers, 10)
        else:
            peers_to_broadcast = peers
        
        # Broadcast to selected peers
        from concurrent.futures import ThreadPoolExecutor
        
        def _send_to_peer(peer):
            try:
                response = requests.post(
                    f"http://{peer}{endpoint}",
                    json=data,
                    timeout=5
                )
                return peer, response.status_code
            except Exception as e:
                logging.debug(f"Error broadcasting to {peer}: {e}")
                return peer, None
        
        with ThreadPoolExecutor(max_workers=5) as executor:
            results = list(executor.map(_send_to_peer, peers_to_broadcast))
        
        # Log results
        success_count = sum(1 for _, status in results if status == 200 or status == 201)
        logging.info(f"Broadcast to {success_count}/{len(peers_to_broadcast)} peers successfully")
    
    def integrate_with_api(self) -> bool:
        """
        Integrate with the Flask API by replacing stub endpoints
        
        Returns:
            True if successful, False otherwise
        """
        if not self.app:
            logging.warning("No Flask app available, cannot integrate API")
            return False
        
        try:
            # Find target endpoints
            endpoints = {
                'consensus_stats_endpoint': self.get_consensus_stats,
                'network_health_endpoint': self.partition_manager.get_network_health_report,
                'reputation_endpoint': self.reputation_consensus.get_reputation_report,
                'consensus_config_endpoint': self.update_consensus_parameters
            }
            
            # Replace stub implementations
            for endpoint_name, implementation in endpoints.items():
                # Check if the endpoint exists in the app
                view_functions = self.app.view_functions
                if endpoint_name in view_functions:
                    # Get the existing endpoint's route
                    for rule in self.app.url_map.iter_rules():
                        if rule.endpoint == endpoint_name:
                            route = rule.rule
                            methods = list(rule.methods)
                            
                            # Remove the existing endpoint
                            self.app.view_functions.pop(endpoint_name, None)
                            
                            # Create a new endpoint with the same route
                            if 'POST' in methods:
                                # For POST endpoints
                                @self.app.route(route, methods=['POST'])
                                def new_endpoint():
                                    try:
                                        data = request.json
                                        result = implementation(data)
                                        return jsonify(result), 200
                                    except Exception as e:
                                        logging.error(f"Error in {endpoint_name}: {e}")
                                        return jsonify({"error": str(e)}), 500
                                
                                # Rename the function to avoid conflicts
                                new_endpoint.__name__ = endpoint_name
                            else:
                                # For GET endpoints
                                @self.app.route(route)
                                def new_endpoint():
                                    try:
                                        result = implementation()
                                        return jsonify(result), 200
                                    except Exception as e:
                                        logging.error(f"Error in {endpoint_name}: {e}")
                                        return jsonify({"error": str(e)}), 500
                                
                                # Rename the function to avoid conflicts
                                new_endpoint.__name__ = endpoint_name
                            
                            logging.info(f"Integrated enhanced implementation for {endpoint_name}")
                            break
                else:
                    logging.warning(f"Endpoint {endpoint_name} not found in Flask app")
            
            logging.info("Successfully integrated with API endpoints")
            return True
        except Exception as e:
            logging.error(f"Error integrating with API: {e}")
            return False