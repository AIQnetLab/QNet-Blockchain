#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: network_partition_manager.py
Implements advanced detection and recovery for network partitions
with improved scalability and performance.
"""

import time
import logging
import threading
import hashlib
import json
import random
import statistics
import requests
import os
import math
import concurrent.futures
from typing import Dict, List, Set, Tuple, Optional, Any, Union
from collections import defaultdict

class NetworkPartitionManager:
    """
    Detects and resolves network partitions in the blockchain network
    with improved scalability for large networks.
    """
    def __init__(self, own_address: str, blockchain: Any, config: Any):
        """
        Initialize the network partition manager
        
        Args:
            own_address: Address of this node
            blockchain: Reference to the blockchain object
            config: Configuration object
        """
        self.own_address = own_address
        self.blockchain = blockchain
        self.config = config
        
        # Track peer chain states
        self.peer_chain_info: Dict[str, Dict[str, Any]] = {}
        
        # Track peer clusters based on chain state
        self.peer_clusters: List[Set[str]] = []
        self.our_cluster: Set[str] = set([own_address])
        
        # Network partition detection thresholds
        self.min_cluster_size = 2
        self.min_height_diff = 3
        
        # Tracking last actions
        self.last_detection_time = 0
        self.last_recovery_time = 0
        self.detection_interval = 300  # 5 minutes
        self.recovery_cooldown = 600   # 10 minutes
        
        # Recovery status
        self.recovery_in_progress = False
        self.recovery_lock = threading.Lock()
        
        # Cache for API responses to reduce network load
        self.response_cache = {}
        self.cache_expiry = 60  # seconds
        
        logging.info("Network partition manager initialized")
    
    def record_peer_chain_info(self, peer: str, chain_length: int, last_block_hash: str,
                             last_block_time: float) -> None:
        """
        Record chain information from a peer
        
        Args:
            peer: Peer address
            chain_length: Length of the peer's blockchain
            last_block_hash: Hash of the peer's last block
            last_block_time: Timestamp of the peer's last block
        """
        if not isinstance(chain_length, int) or chain_length < 0:
            logging.warning(f"Invalid chain length from {peer}: {chain_length}")
            return
            
        if not last_block_hash or not isinstance(last_block_hash, str):
            logging.warning(f"Invalid last block hash from {peer}: {last_block_hash}")
            return
            
        if not isinstance(last_block_time, (int, float)) or last_block_time < 0:
            logging.warning(f"Invalid last block time from {peer}: {last_block_time}")
            return
            
        self.peer_chain_info[peer] = {
            "length": chain_length,
            "last_hash": last_block_hash,
            "last_time": last_block_time,
            "updated_at": time.time()
        }
    
    def _collect_peer_chain_info(self, peers: List[str], timeout: float = 5.0) -> None:
        """
        Collect chain information from peers with improved scalability
        
        Args:
            peers: List of peer addresses
            timeout: Request timeout in seconds
        """
        if not peers:
            logging.warning("No peers provided for chain info collection")
            return
            
        # Calculate sample size based on network size for better scalability
        # Small networks: check all peers, large networks: use logarithmic scaling
        if len(peers) <= 20:
            sample_size = len(peers)
        else:
            # Logarithmic scaling with a minimum of 20 and maximum of 50
            sample_size = min(50, max(20, int(10 * math.log10(len(peers)))))
        
        # Prioritize peers that:
        # 1. Previously reported height differences
        # 2. Were recently added
        # 3. Had connectivity issues
        priorities = {}
        
        for peer in peers:
            # Start with base priority
            priority = 0
            
            # Check last known chain info
            if peer in self.peer_chain_info:
                info = self.peer_chain_info[peer]
                age = time.time() - info.get("updated_at", 0)
                
                # Higher priority for outdated info
                if age > 600:  # 10 minutes
                    priority += 3
                elif age > 300:  # 5 minutes
                    priority += 2
                
                # Check for height differences
                try:
                    our_length = len(self.blockchain.chain)
                    their_length = info.get("length", 0)
                    diff = abs(our_length - their_length)
                    
                    # Higher priority for peers with different chain lengths
                    if diff > 5:
                        priority += 5
                    elif diff > 0:
                        priority += 3
                except Exception:
                    pass
            else:
                # New peers get high priority
                priority += 4
            
            # Store priority
            priorities[peer] = priority
        
        # Select peers based on priority
        selected_peers = sorted(priorities.items(), key=lambda x: x[1], reverse=True)
        selected_peers = [peer for peer, _ in selected_peers[:sample_size]]
        
        # Use thread pool for parallel collection
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(10, len(selected_peers))) as executor:
            futures = {executor.submit(self._fetch_peer_chain_info, peer, timeout): peer for peer in selected_peers}
            for future in concurrent.futures.as_completed(futures, timeout=timeout*2):
                peer = futures[future]
                try:
                    future.result()
                except Exception as e:
                    logging.debug(f"Error collecting chain info from {peer}: {e}")

    def _fetch_peer_chain_info(self, peer: str, timeout: float) -> bool:
        """
        Fetch chain information from a single peer
        
        Args:
            peer: Peer address
            timeout: Request timeout in seconds
            
        Returns:
            True if successful, False otherwise
        """
        # Check cache first
        cache_key = f"chain_info_{peer}"
        if cache_key in self.response_cache:
            cache_entry = self.response_cache[cache_key]
            if time.time() - cache_entry["timestamp"] < self.cache_expiry:
                # Use cached data
                data = cache_entry["data"]
                chain_length = data.get("length", 0)
                
                last_block = None
                if "chain" in data and len(data["chain"]) > 0:
                    last_block = data["chain"][-1]
                
                if last_block:
                    self.record_peer_chain_info(
                        peer,
                        chain_length,
                        last_block.get("hash", ""),
                        last_block.get("timestamp", 0)
                    )
                return True
        
        # Cache miss or expired, fetch from peer
        try:
            response = requests.get(f"http://{peer}/chain", 
                                  params={"limit": 1}, 
                                  timeout=timeout)
            
            if response.status_code == 200:
                data = response.json()
                
                # Cache the response
                self.response_cache[cache_key] = {
                    "data": data,
                    "timestamp": time.time()
                }
                
                chain_length = data.get("length", 0)
                
                last_block = None
                if "chain" in data and len(data["chain"]) > 0:
                    last_block = data["chain"][-1]
                
                if last_block:
                    self.record_peer_chain_info(
                        peer,
                        chain_length,
                        last_block.get("hash", ""),
                        last_block.get("timestamp", 0)
                    )
                return True
            return False
        except requests.RequestException:
            return False
        except Exception as e:
            logging.error(f"Unexpected error fetching chain info from {peer}: {e}")
            return False
    
    def detect_partition(self, peers: List[str]) -> bool:
        """
        Detect potential network partitions
        
        Args:
            peers: List of all known peers
            
        Returns:
            True if a partition is detected, False otherwise
        """
        # Skip if we've recently checked
        if time.time() - self.last_detection_time < self.detection_interval:
            return False
        
        self.last_detection_time = time.time()
        
        # Update peer chain info
        self._collect_peer_chain_info(peers)
        
        # Skip if we don't have enough data
        if len(self.peer_chain_info) < 3:  # Need at least a few peers to detect partitions
            return False
        
        # Group peers by last block hash
        hash_groups: Dict[str, List[str]] = defaultdict(list)
        for peer, info in self.peer_chain_info.items():
            if time.time() - info["updated_at"] > 600:  # Skip outdated data (10 minutes)
                continue
            
            hash_groups[info["last_hash"]].append(peer)
        
        # Find our hash
        our_hash = ""
        try:
            if len(self.blockchain.chain) > 0:
                our_hash = self.blockchain.chain[-1].hash
        except (AttributeError, IndexError) as e:
            logging.error(f"Error getting our last block hash: {e}")
            return False
        
        # Find distinct clusters
        self.peer_clusters = []
        for hash_val, cluster_peers in hash_groups.items():
            if len(cluster_peers) >= self.min_cluster_size:
                self.peer_clusters.append(set(cluster_peers))
        
        # Determine our cluster
        our_cluster: Set[str] = set([self.own_address])
        for cluster in self.peer_clusters:
            for peer in cluster:
                if peer in hash_groups.get(our_hash, []):
                    our_cluster = cluster
                    break
        
        self.our_cluster = our_cluster
        
        # Analyze cluster lengths
        cluster_lengths = []
        try:
            our_length = len(self.blockchain.chain)
        except AttributeError:
            logging.error("Cannot access blockchain chain length")
            return False
        
        for cluster in self.peer_clusters:
            # Get the average chain length in this cluster
            lengths = []
            for peer in cluster:
                if peer in self.peer_chain_info:
                    lengths.append(self.peer_chain_info[peer]["length"])
            
            if lengths:
                try:
                    cluster_lengths.append(statistics.mean(lengths))
                except statistics.StatisticsError:
                    # Handle potential statistics errors
                    if lengths:
                        cluster_lengths.append(sum(lengths) / len(lengths))
        
        # Check if our length is significantly different from other clusters
        for length in cluster_lengths:
            if abs(our_length - length) >= self.min_height_diff:
                logging.warning(f"NETWORK PARTITION DETECTED: Our height {our_length}, "
                               f"other cluster height ~{length}")
                return True
        
        # Check if there are multiple sizable clusters
        if len(self.peer_clusters) > 1:
            sizes = [len(cluster) for cluster in self.peer_clusters]
            logging.warning(f"NETWORK PARTITION DETECTED: Multiple cluster sizes: {sizes}")
            return True
        
        return False
    
    def resolve_partition(self, peers: List[str]) -> bool:
        """
        Attempt to resolve a network partition
        
        Args:
            peers: List of all known peers
            
        Returns:
            True if recovery initiated, False otherwise
        """
        # Skip if we've recently tried recovery
        if time.time() - self.last_recovery_time < self.recovery_cooldown:
            return False
        
        # Skip if recovery is already in progress
        with self.recovery_lock:
            if self.recovery_in_progress:
                return False
            self.recovery_in_progress = True
        
        self.last_recovery_time = time.time()
        
        recovery_succeeded = False
        
        try:
            # Find the largest cluster
            largest_cluster = max(self.peer_clusters, key=len) if self.peer_clusters else set()
            
            # If we're not in the largest cluster, we need to sync with it
            if largest_cluster and self.our_cluster != largest_cluster:
                logging.warning(f"Attempting partition recovery: our cluster size = {len(self.our_cluster)}, "
                              f"largest cluster size = {len(largest_cluster)}")
                
                # Choose a peer from the largest cluster
                if largest_cluster:
                    target_peer = random.choice(list(largest_cluster))
                    
                    # Force aggressive sync with the target
                    if self._force_sync_with_peer(target_peer):
                        recovery_succeeded = True
            
            # Check if we need to perform cross-cluster connections
            if len(self.peer_clusters) > 1:
                # Connect peers from different clusters to repair the partition
                connections_made = 0
                for i, cluster1 in enumerate(self.peer_clusters):
                    for cluster2 in self.peer_clusters[i+1:]:
                        # Introduce a peer from cluster1 to a peer from cluster2
                        if cluster1 and cluster2:
                            peer1 = random.choice(list(cluster1))
                            peer2 = random.choice(list(cluster2))
                            
                            if self._introduce_peers(peer1, peer2):
                                connections_made += 1
                
                if connections_made > 0:
                    logging.info(f"Made {connections_made} cross-cluster connections")
                    recovery_succeeded = True
            
            return recovery_succeeded
        except Exception as e:
            logging.error(f"Error during partition resolution: {e}")
            return False
        finally:
            with self.recovery_lock:
                self.recovery_in_progress = False
    
    def _force_sync_with_peer(self, peer: str) -> bool:
        """
        Force synchronization with a specific peer
        
        Args:
            peer: Target peer address
            
        Returns:
            True if successful, False otherwise
        """
        if not peer:
            logging.error("Cannot sync with empty peer address")
            return False
            
        try:
            logging.info(f"Forcing chain sync with {peer} to recover from partition")
            
            # First, check the peer's chain
            response = requests.get(f"http://{peer}/chain", timeout=10)
            if response.status_code != 200:
                logging.error(f"Failed to get chain from {peer}: {response.status_code}")
                return False
            
            try:
                peer_data = response.json()
                peer_length = peer_data.get("length", 0)
                
                # Store the chain length before sync
                try:
                    our_length = len(self.blockchain.chain)
                except AttributeError:
                    logging.error("Cannot access blockchain chain length")
                    return False
                
                # If the peer's chain is shorter, no need to sync
                if peer_length <= our_length:
                    logging.info(f"Peer {peer} has shorter chain ({peer_length}) than ours ({our_length})")
                    return False
                
                # Request chain sync
                sync_url = f"http://{self.own_address}/sync_chain?force=true&peer={peer}"
                sync_response = requests.get(sync_url, timeout=30)
                
                if sync_response.status_code == 200:
                    logging.info(f"Successfully initiated force sync with {peer}")
                    
                    # Wait a bit for the sync to complete
                    time.sleep(5)
                    
                    # Verify the sync worked by checking if our chain is longer now
                    try:
                        new_length = len(self.blockchain.chain)
                        if new_length > our_length:
                            logging.info(f"Sync successful: Chain length increased from {our_length} to {new_length}")
                            return True
                        else:
                            logging.warning(f"Sync did not increase chain length. Possible issue.")
                            return False
                    except AttributeError:
                        logging.error("Cannot access blockchain chain length after sync")
                        return False
                else:
                    logging.error(f"Failed to initiate sync: {sync_response.status_code}")
                    return False
            except ValueError:
                logging.error(f"Invalid JSON response from {peer}")
                return False
        except requests.RequestException as e:
            logging.error(f"Request error during force sync with {peer}: {e}")
            return False
        except Exception as e:
            logging.error(f"Error during force sync with {peer}: {e}")
            return False
    
    def _introduce_peers(self, peer1: str, peer2: str) -> bool:
        """
        Introduce two peers to each other to help heal network partition
        
        Args:
            peer1: First peer address
            peer2: Second peer address
            
        Returns:
            True if successful, False otherwise
        """
        if not peer1 or not peer2 or peer1 == peer2:
            logging.warning(f"Invalid peer addresses for introduction: {peer1}, {peer2}")
            return False
            
        logging.info(f"Introducing peers {peer1} and {peer2} to help heal partition")
        
        success = False
        
        # Introduce peer2 to peer1
        try:
            response = requests.post(
                f"http://{peer1}/add_peer",
                json={"peer": peer2},
                timeout=5
            )
            if response.status_code == 200 or response.status_code == 201:
                logging.info(f"Successfully introduced {peer2} to {peer1}")
                success = True
        except requests.RequestException as e:
            logging.error(f"Request error introducing {peer2} to {peer1}: {e}")
        except Exception as e:
            logging.error(f"Error introducing {peer2} to {peer1}: {e}")
        
        # Introduce peer1 to peer2
        try:
            response = requests.post(
                f"http://{peer2}/add_peer",
                json={"peer": peer1},
                timeout=5
            )
            if response.status_code == 200 or response.status_code == 201:
                logging.info(f"Successfully introduced {peer1} to {peer2}")
                success = True
        except requests.RequestException as e:
            logging.error(f"Request error introducing {peer1} to {peer2}: {e}")
        except Exception as e:
            logging.error(f"Error introducing {peer1} to {peer2}: {e}")
        
        return success
    
    def start_monitoring(self, interval: int = 300) -> threading.Thread:
        """
        Start a background thread to monitor for network partitions
        
        Args:
            interval: Check interval in seconds
            
        Returns:
            The monitoring thread
        """
        # Ensure interval is reasonable
        if interval < 60:
            logging.warning(f"Partition check interval too low: {interval}, setting to 60 seconds")
            interval = 60
        
        def _monitor_loop():
            while True:
                try:
                    # Get current peers
                    try:
                        peers = list(self.config.peers.keys()) if hasattr(self.config, 'peers') else []
                    except (AttributeError, TypeError) as e:
                        logging.error(f"Error accessing peers: {e}")
                        peers = []
                    
                    if not peers:
                        logging.warning("No peers available for partition detection")
                        time.sleep(interval)
                        continue
                    
                    # Check for partitions
                    partition_detected = False
                    try:
                        partition_detected = self.detect_partition(peers)
                    except Exception as e:
                        logging.error(f"Error detecting partition: {e}")
                    
                    # Try to resolve if detected
                    if partition_detected:
                        try:
                            self.resolve_partition(peers)
                        except Exception as e:
                            logging.error(f"Error resolving partition: {e}")
                    
                    # Clean up old cache entries
                    self._clean_cache()
                    
                    time.sleep(interval)
                except Exception as e:
                    logging.error(f"Error in network partition monitoring: {e}")
                    time.sleep(60)  # Wait a bit before trying again
        
        monitor_thread = threading.Thread(target=_monitor_loop, daemon=True)
        monitor_thread.start()
        return monitor_thread
    
    def _clean_cache(self) -> None:
        """Clean up expired cache entries"""
        current_time = time.time()
        keys_to_remove = []
        
        for key, entry in self.response_cache.items():
            if current_time - entry["timestamp"] > self.cache_expiry:
                keys_to_remove.append(key)
        
        for key in keys_to_remove:
            del self.response_cache[key]
        
        if keys_to_remove:
            logging.debug(f"Cleaned {len(keys_to_remove)} expired cache entries")

    def get_network_health_report(self) -> Dict[str, Any]:
        """
        Generate a report on network health and partition status
        
        Returns:
            Dictionary with network health information
        """
        try:
            our_length = len(self.blockchain.chain)
        except (AttributeError, TypeError):
            logging.error("Cannot access blockchain chain length")
            our_length = 0
        
        # Calculate statistics about chains in the network
        lengths = []
        for info in self.peer_chain_info.values():
            if time.time() - info["updated_at"] < 600:  # Only use fresh data
                lengths.append(info["length"])
        
        if lengths:
            try:
                avg_length = statistics.mean(lengths)
                max_length = max(lengths)
                min_length = min(lengths)
                
                # Calculate standard deviation if we have enough data
                if len(lengths) > 1:
                    length_std_dev = statistics.stdev(lengths)
                else:
                    length_std_dev = 0
            except (statistics.StatisticsError, ValueError, TypeError):
                avg_length = sum(lengths) / len(lengths) if lengths else 0
                max_length = max(lengths) if lengths else 0
                min_length = min(lengths) if lengths else 0
                length_std_dev = 0
        else:
            avg_length = our_length
            max_length = our_length
            min_length = our_length
            length_std_dev = 0
        
        # Detect divergent blocks
        try:
            divergent_blocks = self._detect_divergent_blocks()
        except Exception as e:
            logging.error(f"Error detecting divergent blocks: {e}")
            divergent_blocks = []
        
        # Get information about clusters
        try:
            clusters_info = [{"size": len(cluster), "peers": list(cluster)[:5]} 
                           for cluster in self.peer_clusters]
        except Exception as e:
            logging.error(f"Error getting cluster info: {e}")
            clusters_info = []
        
        return {
            "our_chain_length": our_length,
            "average_chain_length": avg_length,
            "max_chain_length": max_length,
            "min_chain_length": min_length,
            "chain_length_std_dev": length_std_dev,
            "node_count": len(self.peer_chain_info) + 1,  # +1 for our node
            "cluster_count": len(self.peer_clusters),
            "clusters": clusters_info,
            "our_cluster_size": len(self.our_cluster),
            "partition_detected": len(self.peer_clusters) > 1,
            "divergent_block_count": len(divergent_blocks),
            "divergent_blocks": divergent_blocks[:5],  # Limit to 5 for brevity
            "last_detection_time": self.last_detection_time,
            "last_recovery_time": self.last_recovery_time,
            "recovery_in_progress": self.recovery_in_progress,
            "timestamp": time.time()
        }
    
    def _detect_divergent_blocks(self) -> List[Dict[str, Any]]:
        """
        Detect divergent blocks at the same height
        
        Returns:
            List of divergent block information
        """
        # Collect block hashes at each height
        height_to_hashes: Dict[int, Dict[str, List[str]]] = defaultdict(lambda: defaultdict(list))
        
        # Add our blocks
        try:
            for i, block in enumerate(self.blockchain.chain):
                if hasattr(block, 'hash'):
                    height_to_hashes[i][block.hash].append(self.own_address)
        except (AttributeError, TypeError, IndexError) as e:
            logging.error(f"Error accessing our blockchain: {e}")
        
        # Limit peer chain requests to avoid overloading the network
        # Choose a random subset of peers to query
        max_peers_to_check = 5
        
        # Select peers that reported height differences
        peers_with_diff = []
        for peer, info in self.peer_chain_info.items():
            if time.time() - info["updated_at"] < 600:  # Only use fresh data
                try:
                    our_length = len(self.blockchain.chain)
                    if abs(info["length"] - our_length) > 0:
                        peers_with_diff.append(peer)
                except (AttributeError, TypeError):
                    continue
        
        # If we have more than max_peers_to_check with differences, randomly sample
        if len(peers_with_diff) > max_peers_to_check:
            peers_to_check = random.sample(peers_with_diff, max_peers_to_check)
        else:
            peers_to_check = peers_with_diff
            
        # If we don't have enough peers with differences, add some random peers
        if len(peers_to_check) < max_peers_to_check:
            all_peers = list(self.peer_chain_info.keys())
            remaining_peers = [p for p in all_peers if p not in peers_to_check]
            if remaining_peers:
                additional_count = min(max_peers_to_check - len(peers_to_check), len(remaining_peers))
                if additional_count > 0:
                    peers_to_check.extend(random.sample(remaining_peers, additional_count))
        
        # Check with peers
        divergent_blocks = []
        
        # Cache the responses to avoid redundant requests
        peer_chains = {}
        
        # For each peer, request their chain
        for peer in peers_to_check:
            try:
                # Check cache first
                cache_key = f"full_chain_{peer}"
                if cache_key in self.response_cache:
                    cache_entry = self.response_cache[cache_key]
                    if time.time() - cache_entry["timestamp"] < self.cache_expiry:
                        peer_chains[peer] = cache_entry["data"].get("chain", [])
                        continue
                
                # Request chain from peer (with reasonable limit)
                response = requests.get(f"http://{peer}/chain", params={"limit": 50}, timeout=10)
                if response.status_code == 200:
                    try:
                        data = response.json()
                        peer_chains[peer] = data.get("chain", [])
                        
                        # Cache the response
                        self.response_cache[cache_key] = {
                            "data": data,
                            "timestamp": time.time()
                        }
                    except ValueError:
                        logging.warning(f"Invalid JSON response from {peer}")
            except requests.RequestException as e:
                logging.debug(f"Request error fetching chain from {peer}: {e}")
            except Exception as e:
                logging.error(f"Error getting chain from {peer}: {e}")
        
        # Record block hashes from peer chains
        for peer, chain in peer_chains.items():
            for i, block in enumerate(chain):
                block_hash = block.get("hash", "")
                if block_hash:
                    height_to_hashes[i][block_hash].append(peer)
        
        # Find heights with multiple hashes
        for height, hashes in height_to_hashes.items():
            if len(hashes) > 1:
                # We have multiple hashes at this height
                hash_info = []
                for block_hash, peers in hashes.items():
                    hash_info.append({
                        "hash": block_hash,
                        "peer_count": len(peers),
                        "peers": peers[:5]  # Limit to 5 peers for brevity
                    })
                
                divergent_blocks.append({
                    "height": height,
                    "hash_count": len(hashes),
                    "blocks": hash_info
                })
        
        return sorted(divergent_blocks, key=lambda x: x["height"])