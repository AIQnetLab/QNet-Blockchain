#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: reputation_consensus.py
Implements a reputation-based leader selection algorithm for consensus
with improved locking mechanism, determinism, and performance at scale.
"""

import time
import logging
import threading
import hashlib
import json
import random
import math
import statistics
import collections
from typing import Dict, List, Set, Tuple, Optional, Any, Union

# Advanced read-write lock for better concurrency
class ReadWriteLock:
    """
    A lock object that allows many simultaneous "read locks", but
    only one "write lock" at a time.
    """
    def __init__(self):
        self._read_ready = threading.Condition(threading.Lock())
        self._readers = 0
        self._writers = 0
        self._write_waiting = 0
        self._owner = None  # Thread ID of write lock owner

    def acquire_read(self, timeout=None):
        """Acquire a read lock. Blocks only if a thread has acquired the write lock."""
        with self._read_ready:
            if not self._read_ready.wait_for(
                lambda: self._writers == 0 and self._write_waiting == 0, 
                timeout=timeout
            ):
                return False
            self._readers += 1
            return True

    def release_read(self):
        """Release a read lock."""
        with self._read_ready:
            self._readers -= 1
            if self._readers == 0:
                self._read_ready.notify_all()

    def acquire_write(self, timeout=None):
        """Acquire a write lock. Blocks until there are no acquired read or write locks."""
        me = threading.get_ident()
        with self._read_ready:
            if self._owner == me:
                self._writers += 1
                return True
                
            self._write_waiting += 1
            try:
                if not self._read_ready.wait_for(
                    lambda: self._readers == 0 and self._writers == 0,
                    timeout=timeout
                ):
                    return False
                self._writers += 1
                self._owner = me
                return True
            finally:
                self._write_waiting -= 1

    def release_write(self):
        """Release a write lock."""
        me = threading.get_ident()
        with self._read_ready:
            if self._owner != me:
                raise RuntimeError("Cannot release write lock - not the owner")
            
            self._writers -= 1
            if self._writers == 0:
                self._owner = None
                self._read_ready.notify_all()

class ReadLockContext:
    """Context manager for read lock."""
    def __init__(self, rwlock):
        self.rwlock = rwlock

    def __enter__(self):
        self.rwlock.acquire_read()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.rwlock.release_read()

class WriteLockContext:
    """Context manager for write lock."""
    def __init__(self, rwlock):
        self.rwlock = rwlock

    def __enter__(self):
        self.rwlock.acquire_write()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.rwlock.release_write()

class NodeReputation:
    """
    Manages reputation scores for nodes in the network
    """
    def __init__(self, own_address: str, config: Any):
        """
        Initialize the node reputation manager
        
        Args:
            own_address: Address of this node
            config: Configuration object
        """
        self.own_address = own_address
        self.config = config
        
        # Reputation scores (0.0 to 1.0)
        self.reputation_scores: Dict[str, float] = {}
        
        # Performance metrics
        self.participation_history: Dict[str, List[bool]] = {}  # node -> list of participation flags
        self.response_times: Dict[str, List[float]] = {}  # node -> list of response times
        self.block_quality: Dict[str, List[float]] = {}  # node -> list of block quality scores
        
        # History window size
        self.history_size = 100
        
        # Weights for different factors
        self.weights = {
            "participation": 0.4,
            "response_time": 0.3,
            "block_quality": 0.3
        }
        
        # Default initial reputation
        self.default_reputation = 0.5
        
        # Minimum data points required for full reputation assessment
        self.min_data_points = 5
        
        # Decay parameter for historical data (higher value means faster decay)
        self.decay_factor = 0.95
        
        # Use ReadWriteLock for better concurrency
        self.rwlock = ReadWriteLock()
        
        # Add own node with perfect score
        self.reputation_scores[own_address] = 1.0
        
        logging.info("Node reputation manager initialized")
    
    def add_node(self, node_address: str) -> None:
        """
        Add a new node with default reputation
        
        Args:
            node_address: Address of the node to add
        """
        if not node_address or not isinstance(node_address, str):
            logging.warning(f"Invalid node address: {node_address}")
            return
            
        with WriteLockContext(self.rwlock):
            if node_address not in self.reputation_scores:
                self.reputation_scores[node_address] = self.default_reputation
                self.participation_history[node_address] = []
                self.response_times[node_address] = []
                self.block_quality[node_address] = []
    
    def record_participation(self, node_address: str, participated: bool) -> None:
        """
        Record node participation in a consensus round
        
        Args:
            node_address: Node address
            participated: Whether the node participated
        """
        if not node_address or not isinstance(node_address, str):
            logging.warning(f"Invalid node address: {node_address}")
            return
            
        with WriteLockContext(self.rwlock):
            self._ensure_node_exists(node_address)
            
            self.participation_history[node_address].append(participated)
            
            # Limit history size
            if len(self.participation_history[node_address]) > self.history_size:
                self.participation_history[node_address] = self.participation_history[node_address][-self.history_size:]
            
            # Update reputation score
            self._update_reputation(node_address)
    
    def record_response_time(self, node_address: str, response_time: float) -> None:
        """
        Record node response time
        
        Args:
            node_address: Node address
            response_time: Response time in seconds
        """
        if not node_address or not isinstance(node_address, str):
            logging.warning(f"Invalid node address: {node_address}")
            return
            
        if not isinstance(response_time, (int, float)) or response_time < 0:
            logging.warning(f"Invalid response time for {node_address}: {response_time}")
            return
            
        with WriteLockContext(self.rwlock):
            self._ensure_node_exists(node_address)
            
            self.response_times[node_address].append(response_time)
            
            # Limit history size
            if len(self.response_times[node_address]) > self.history_size:
                self.response_times[node_address] = self.response_times[node_address][-self.history_size:]
            
            # Update reputation score
            self._update_reputation(node_address)
    
    def record_block_quality(self, node_address: str, quality_score: float) -> None:
        """
        Record quality of a block produced by a node
        
        Args:
            node_address: Node address
            quality_score: Quality score (0.0 to 1.0)
        """
        if not node_address or not isinstance(node_address, str):
            logging.warning(f"Invalid node address: {node_address}")
            return
            
        if not isinstance(quality_score, (int, float)) or quality_score < 0 or quality_score > 1.0:
            logging.warning(f"Invalid quality score for {node_address}: {quality_score}")
            return
            
        with WriteLockContext(self.rwlock):
            self._ensure_node_exists(node_address)
            
            self.block_quality[node_address].append(quality_score)
            
            # Limit history size
            if len(self.block_quality[node_address]) > self.history_size:
                self.block_quality[node_address] = self.block_quality[node_address][-self.history_size:]
            
            # Update reputation score
            self._update_reputation(node_address)
    
    def get_reputation(self, node_address: str) -> float:
        """
        Get the current reputation score for a node
        
        Args:
            node_address: Node address
            
        Returns:
            Reputation score (0.0 to 1.0)
        """
        with ReadLockContext(self.rwlock):
            self._ensure_node_exists(node_address)
            return self.reputation_scores[node_address]
    
    def get_all_reputations(self) -> Dict[str, float]:
        """
        Get reputation scores for all nodes
        
        Returns:
            Dictionary mapping node addresses to reputation scores
        """
        with ReadLockContext(self.rwlock):
            return dict(self.reputation_scores)
    
    def _ensure_node_exists(self, node_address: str) -> None:
        """
        Ensure a node exists in the reputation system
        
        Args:
            node_address: Node address
        """
        if node_address not in self.reputation_scores:
            self.add_node(node_address)
    
    def _update_reputation(self, node_address: str) -> None:
        """
        Update the reputation score for a node based on all factors
        
        Args:
            node_address: Node address
        """
        # Calculate participation score
        participation_score = self._calculate_participation_score(node_address)
        
        # Calculate response time score
        response_time_score = self._calculate_response_time_score(node_address)
        
        # Calculate block quality score
        block_quality_score = self._calculate_block_quality_score(node_address)
        
        # Calculate weighted average
        has_participation = participation_score is not None
        has_response_time = response_time_score is not None
        has_block_quality = block_quality_score is not None
        
        # Adjust weights based on available data
        adjusted_weights = dict(self.weights)
        total_weight = 0
        
        if has_participation:
            total_weight += adjusted_weights["participation"]
        else:
            adjusted_weights["participation"] = 0
        
        if has_response_time:
            total_weight += adjusted_weights["response_time"]
        else:
            adjusted_weights["response_time"] = 0
        
        if has_block_quality:
            total_weight += adjusted_weights["block_quality"]
        else:
            adjusted_weights["block_quality"] = 0
        
        # If we have no data at all, keep the default reputation
        if total_weight == 0:
            return
        
        # Normalize weights
        if total_weight > 0:
            for key in adjusted_weights:
                adjusted_weights[key] /= total_weight
        
        # Calculate weighted score
        weighted_score = 0
        if has_participation:
            weighted_score += participation_score * adjusted_weights["participation"]
        if has_response_time:
            weighted_score += response_time_score * adjusted_weights["response_time"]
        if has_block_quality:
            weighted_score += block_quality_score * adjusted_weights["block_quality"]
        
        # Apply a slight regression toward the mean to prevent extreme values
        current_score = self.reputation_scores[node_address]
        regression_factor = 0.95  # 5% regression toward the mean
        mean_score = 0.5
        
        new_score = regression_factor * weighted_score + (1 - regression_factor) * mean_score
        
        # Apply exponential moving average to smooth changes
        smoothing_factor = 0.2  # 20% weight for new data
        smoothed_score = smoothing_factor * new_score + (1 - smoothing_factor) * current_score
        
        # Clamp to valid range
        self.reputation_scores[node_address] = max(0.0, min(1.0, smoothed_score))
    
    def _calculate_participation_score(self, node_address: str) -> Optional[float]:
        """
        Calculate participation score based on history
        
        Args:
            node_address: Node address
            
        Returns:
            Participation score (0.0 to 1.0) or None if insufficient data
        """
        history = self.participation_history.get(node_address, [])
        if not history:
            return None
        
        # Apply time decay to give more weight to recent participation
        weighted_sum = 0
        weight_sum = 0
        
        try:
            for i, participated in enumerate(history):
                # More recent entries have higher weight
                weight = self.decay_factor ** (len(history) - i - 1)
                weighted_sum += weight * (1.0 if participated else 0.0)
                weight_sum += weight
            
            if weight_sum > 0:
                return weighted_sum / weight_sum
        except Exception as e:
            logging.error(f"Error calculating participation score for {node_address}: {e}")
        
        return None
    
    def _calculate_response_time_score(self, node_address: str) -> Optional[float]:
        """
        Calculate response time score based on history
        
        Args:
            node_address: Node address
            
        Returns:
            Response time score (0.0 to 1.0) or None if insufficient data
        """
        times = self.response_times.get(node_address, [])
        if not times or len(times) < self.min_data_points:
            return None
        
        # Find min and max times for normalization
        all_times = []
        for node, node_times in self.response_times.items():
            all_times.extend(node_times)
        
        if not all_times:
            return None
        
        try:
            min_time = min(all_times)
            max_time = max(all_times)
            
            if min_time == max_time:
                return 1.0  # All response times are the same
            
            # Apply time decay to give more weight to recent response times
            weighted_sum = 0
            weight_sum = 0
            
            for i, response_time in enumerate(times):
                # More recent entries have higher weight
                weight = self.decay_factor ** (len(times) - i - 1)
                
                # Normalize and invert (faster responses get higher scores)
                normalized_time = (response_time - min_time) / (max_time - min_time)
                inverted_score = 1.0 - normalized_time
                
                weighted_sum += weight * inverted_score
                weight_sum += weight
            
            if weight_sum > 0:
                return weighted_sum / weight_sum
        except (ValueError, ZeroDivisionError) as e:
            logging.error(f"Error calculating response time score for {node_address}: {e}")
        
        return None
    
    def _calculate_block_quality_score(self, node_address: str) -> Optional[float]:
        """
        Calculate block quality score based on history
        
        Args:
            node_address: Node address
            
        Returns:
            Block quality score (0.0 to 1.0) or None if insufficient data
        """
        quality_scores = self.block_quality.get(node_address, [])
        if not quality_scores or len(quality_scores) < 2:  # Need at least a couple blocks to judge
            return None
        
        # Apply time decay to give more weight to recent blocks
        weighted_sum = 0
        weight_sum = 0
        
        try:
            for i, quality in enumerate(quality_scores):
                # More recent entries have higher weight
                weight = self.decay_factor ** (len(quality_scores) - i - 1)
                weighted_sum += weight * quality
                weight_sum += weight
            
            if weight_sum > 0:
                return weighted_sum / weight_sum
        except Exception as e:
            logging.error(f"Error calculating block quality score for {node_address}: {e}")
        
        return None
    
    def apply_penalty(self, node_address: str, reason: str, severity: float) -> None:
        """
        Apply a reputation penalty to a node
        
        Args:
            node_address: Node address
            reason: Reason for the penalty
            severity: Severity of the penalty (0.0 to 1.0)
        """
        if not node_address or not isinstance(node_address, str):
            logging.warning(f"Invalid node address: {node_address}")
            return
            
        if not isinstance(severity, (int, float)) or severity < 0 or severity > 1.0:
            logging.warning(f"Invalid severity for {node_address}: {severity}")
            return
            
        with WriteLockContext(self.rwlock):
            self._ensure_node_exists(node_address)
            
            current_score = self.reputation_scores[node_address]
            penalty = current_score * severity
            
            new_score = max(0.1, current_score - penalty)  # Ensure score doesn't go below 0.1
            self.reputation_scores[node_address] = new_score
            
            logging.info(f"Applied reputation penalty to {node_address} for {reason}. "
                       f"Score changed from {current_score:.2f} to {new_score:.2f}")
    
    def apply_reward(self, node_address: str, reason: str, magnitude: float) -> None:
        """
        Apply a reputation reward to a node
        
        Args:
            node_address: Node address
            reason: Reason for the reward
            magnitude: Magnitude of the reward (0.0 to 1.0)
        """
        if not node_address or not isinstance(node_address, str):
            logging.warning(f"Invalid node address: {node_address}")
            return
            
        if not isinstance(magnitude, (int, float)) or magnitude < 0 or magnitude > 1.0:
            logging.warning(f"Invalid magnitude for {node_address}: {magnitude}")
            return
            
        with WriteLockContext(self.rwlock):
            self._ensure_node_exists(node_address)
            
            current_score = self.reputation_scores[node_address]
            reward = (1.0 - current_score) * magnitude
            
            new_score = min(1.0, current_score + reward)  # Ensure score doesn't go above 1.0
            self.reputation_scores[node_address] = new_score
            
            logging.info(f"Applied reputation reward to {node_address} for {reason}. "
                       f"Score changed from {current_score:.2f} to {new_score:.2f}")

class ReputationConsensusManager:
    """
    Enhanced consensus manager that uses node reputation for leader selection
    with deterministic behavior across nodes
    """
    def __init__(self, own_address: str, node_reputation: NodeReputation, config: Any):
        """
        Initialize the reputation-based consensus manager
        
        Args:
            own_address: Address of this node
            node_reputation: Node reputation manager
            config: Configuration object
        """
        self.own_address = own_address
        self.node_reputation = node_reputation
        self.config = config
        
        # Consensus state
        self.commits: Dict[int, Dict[str, str]] = {}  # round -> (node -> commit)
        self.reveals: Dict[int, Dict[str, str]] = {}  # round -> (node -> reveal)
        
        # Leader history
        self.round_leaders: Dict[int, str] = {}  # round -> leader node
        
        # Success tracking
        self.successful_rounds: Set[int] = set()
        
        # Use ReadWriteLock for better concurrency
        self.rwlock = ReadWriteLock()
        
        # Reputation influence (0.0 means random selection, 1.0 means fully reputation-based)
        self.reputation_influence = 0.7
        
        # Minimum nodes for valid consensus
        self.min_reveals = 2
        
        # Tracking node participation
        self.node_participation: Dict[int, Set[str]] = {}  # round -> set of participating nodes
        
        logging.info("Reputation-based consensus manager initialized")
    
    def add_commit(self, round_num: int, node_address: str, commit_value: str) -> None:
        """
        Add a commit from a node for a consensus round
        
        Args:
            round_num: Consensus round number
            node_address: Node address
            commit_value: Commit value
        """
        if not isinstance(round_num, int) or round_num < 0:
            logging.warning(f"Invalid round number: {round_num}")
            return
            
        if not node_address or not isinstance(node_address, str):
            logging.warning(f"Invalid node address: {node_address}")
            return
            
        if not commit_value or not isinstance(commit_value, str):
            logging.warning(f"Invalid commit value from {node_address}: {commit_value}")
            return
            
        with WriteLockContext(self.rwlock):
            if round_num not in self.commits:
                self.commits[round_num] = {}
            
            self.commits[round_num][node_address] = commit_value
            
            # Track node participation
            if round_num not in self.node_participation:
                self.node_participation[round_num] = set()
            
            self.node_participation[round_num].add(node_address)
            
            # Record participation in reputation system
            try:
                self.node_reputation.record_participation(node_address, True)
            except Exception as e:
                logging.error(f"Error recording participation for {node_address}: {e}")
    
    def add_reveal(self, round_num: int, node_address: str, reveal_value: str) -> None:
        """
        Add a reveal from a node for a consensus round
        
        Args:
            round_num: Consensus round number
            node_address: Node address
            reveal_value: Reveal value
        """
        if not isinstance(round_num, int) or round_num < 0:
            logging.warning(f"Invalid round number: {round_num}")
            return
            
        if not node_address or not isinstance(node_address, str):
            logging.warning(f"Invalid node address: {node_address}")
            return
            
        if not reveal_value or not isinstance(reveal_value, str):
            logging.warning(f"Invalid reveal value from {node_address}: {reveal_value}")
            return
            
        with WriteLockContext(self.rwlock):
            if round_num not in self.reveals:
                self.reveals[round_num] = {}
            
            # Verify that the reveal matches the commit
            if round_num in self.commits and node_address in self.commits[round_num]:
                try:
                    expected_commit = hashlib.sha256(reveal_value.encode()).hexdigest()
                    actual_commit = self.commits[round_num][node_address]
                    
                    if expected_commit != actual_commit:
                        logging.warning(f"Reveal from {node_address} for round {round_num} doesn't match commit")
                        # Apply reputation penalty for invalid reveal
                        try:
                            self.node_reputation.apply_penalty(node_address, "Invalid reveal", 0.2)
                        except Exception as e:
                            logging.error(f"Error applying penalty to {node_address}: {e}")
                        return
                except Exception as e:
                    logging.error(f"Error verifying reveal for {node_address}: {e}")
                    return
            
            self.reveals[round_num][node_address] = reveal_value
            
            # Track node participation
            if round_num not in self.node_participation:
                self.node_participation[round_num] = set()
            
            self.node_participation[round_num].add(node_address)
    
    def determine_leader(self, round_num: int, eligible_nodes: List[str], 
                       random_beacon: str) -> Optional[str]:
        """
        Determine leader for a consensus round using reputation-weighted selection
        
        Args:
            round_num: Consensus round number
            eligible_nodes: List of eligible nodes
            random_beacon: Random beacon for deterministic selection
            
        Returns:
            Address of the selected leader node, or None if consensus failed
        """
        if not isinstance(round_num, int) or round_num < 0:
            logging.warning(f"Invalid round number: {round_num}")
            return None
            
        if not eligible_nodes:
            logging.warning("No eligible nodes for leader selection")
            return None
            
        if not random_beacon or not isinstance(random_beacon, str):
            logging.warning(f"Invalid random beacon: {random_beacon}")
            return None
            
        # First get valid reveals using a read lock
        valid_reveals = []
        with ReadLockContext(self.rwlock):
            # Check if we have enough reveals
            if round_num not in self.reveals:
                logging.warning(f"No reveals for round {round_num}")
                return None
                
            valid_reveals = self._get_valid_reveals(round_num, eligible_nodes)
            
            if len(valid_reveals) < self.min_reveals:
                logging.warning(f"Not enough valid reveals for round {round_num}. "
                              f"Got {len(valid_reveals)}, need {self.min_reveals}")
                return None
                
        # Determine leader without holding the lock
        leader = self._select_leader_with_reputation(eligible_nodes, valid_reveals, random_beacon)
        
        # Update state with the result using a write lock
        if leader:
            with WriteLockContext(self.rwlock):
                logging.info(f"Selected leader {leader} for round {round_num}")
                self.round_leaders[round_num] = leader
                
                # Record the round as successful
                self.successful_rounds.add(round_num)
                
                # Apply reward to participating nodes
                for node in valid_reveals:
                    try:
                        self.node_reputation.apply_reward(node, "Successful consensus participation", 0.05)
                    except Exception as e:
                        logging.error(f"Error applying reward to {node}: {e}")
                
                # Apply extra reward to leader
                try:
                    self.node_reputation.apply_reward(leader, "Selected as leader", 0.1)
                except Exception as e:
                    logging.error(f"Error applying reward to leader {leader}: {e}")
        
        return leader
    
    def _get_valid_reveals(self, round_num: int, eligible_nodes: List[str]) -> List[str]:
        """
        Get list of nodes with valid reveals for a round
        
        Args:
            round_num: Consensus round number
            eligible_nodes: List of eligible nodes
            
        Returns:
            List of nodes with valid reveals
        """
        valid_reveals = []
        
        if round_num not in self.reveals:
            return valid_reveals
            
        try:
            for node, reveal in self.reveals[round_num].items():
                # Check if node is eligible
                if node not in eligible_nodes:
                    continue
                
                # Check if the node has a matching commit
                if round_num in self.commits and node in self.commits[round_num]:
                    try:
                        expected_commit = hashlib.sha256(reveal.encode()).hexdigest()
                        actual_commit = self.commits[round_num][node]
                        
                        if expected_commit == actual_commit:
                            valid_reveals.append(node)
                    except Exception as e:
                        logging.error(f"Error validating reveal for {node}: {e}")
        except Exception as e:
            logging.error(f"Error getting valid reveals for round {round_num}: {e}")
        
        return valid_reveals
    
    def _select_leader_with_reputation(self, eligible_nodes: List[str], 
                                     participating_nodes: List[str],
                                     random_beacon: str) -> Optional[str]:
        """
        Select a leader using reputation-weighted deterministic selection.
        
        Args:
            eligible_nodes: List of eligible nodes
            participating_nodes: List of nodes participating in this round
            random_beacon: Random beacon for deterministic selection
            
        Returns:
            Selected leader address or None if no suitable leader
        """
        if not eligible_nodes or not participating_nodes or not random_beacon:
            logging.warning("Missing required parameters for leader selection")
            return None
            
        # Find the intersection of eligible and participating nodes
        # Use sorted to ensure deterministic behavior
        candidates = sorted([node for node in eligible_nodes if node in participating_nodes])
        
        if not candidates:
            logging.warning("No candidate nodes for leader selection")
            return None
            
        # If reputation influence is 0, use pure deterministic selection
        if self.reputation_influence <= 0:
            # Generate a deterministic seed from the random beacon
            seed_input = f"{random_beacon}:leader_selection".encode('utf-8')
            seed_hash = hashlib.sha256(seed_input).digest()
            seed_value = int.from_bytes(seed_hash, byteorder='big')
            
            # Deterministically select a leader
            index = seed_value % len(candidates)
            return candidates[index]
        
        # Get reputation scores for all candidates
        reputation_scores = {}
        for node in candidates:
            try:
                reputation_scores[node] = self.node_reputation.get_reputation(node)
            except Exception as e:
                logging.error(f"Error getting reputation for {node}: {e}")
                # Use a deterministic default value
                node_hash = hashlib.sha256(node.encode('utf-8')).digest()
                node_value = int.from_bytes(node_hash, byteorder='big') % 100
                reputation_scores[node] = 0.1 + (node_value / 1000.0)  # Between 0.1 and 0.2
        
        # Apply reputation influence (blend with uniform distribution)
        # Sort nodes to ensure deterministic processing order
        sorted_nodes = sorted(candidates)
        adjusted_scores = {}
        
        total_score = 0.0
        for node in sorted_nodes:
            score = reputation_scores.get(node, 0.5)
            # Blend reputation score with uniform baseline
            uniform_score = 1.0 / len(candidates)
            adjusted_score = (self.reputation_influence * score) + ((1 - self.reputation_influence) * uniform_score)
            adjusted_scores[node] = adjusted_score
            total_score += adjusted_score
        
        # Normalize to sum to 1.0 exactly
        if total_score > 0:
            for node in sorted_nodes:
                adjusted_scores[node] /= total_score
        
        # Create deterministic cumulative distribution
        cumulative = 0.0
        distribution = []
        for node in sorted_nodes:
            cumulative += adjusted_scores[node]
            # Ensure exact precision by rounding to 16 decimal places
            cumulative = round(cumulative, 16)
            distribution.append((node, cumulative))
        
        # The last entry should always be exactly 1.0
        if distribution:
            distribution[-1] = (distribution[-1][0], 1.0)
        
        # Derive a deterministic value from the random beacon
        prng_seed = int.from_bytes(hashlib.sha256(random_beacon.encode('utf-8')).digest(), byteorder='big')
        
        # Create a deterministic PRNG
        random_state = random.Random(prng_seed)
        
        # Generate a deterministic value between 0 and 1
        random_value = random_state.random()
        
        # Select based on the random value using binary search for efficiency
        left, right = 0, len(distribution) - 1
        while left <= right:
            mid = (left + right) // 2
            if mid > 0 and distribution[mid-1][1] <= random_value < distribution[mid][1]:
                return distribution[mid][0]
            elif mid == 0 and random_value < distribution[mid][1]:
                return distribution[mid][0]
            elif random_value < distribution[mid][1]:
                right = mid - 1
            else:
                left = mid + 1
        
        # Fallback to last node (should never happen with proper distribution)
        if distribution:
            return distribution[-1][0]
        
        # Final fallback if distribution is empty
        return candidates[0] if candidates else None
    
    def get_round_stats(self, round_num: int) -> Dict[str, Any]:
        """
        Get statistics for a consensus round
        
        Args:
            round_num: Consensus round number
            
        Returns:
            Dictionary with round statistics
        """
        with ReadLockContext(self.rwlock):
            result = {"round": round_num}
            
            try:
                commits = self.commits.get(round_num, {})
                reveals = self.reveals.get(round_num, {})
                participating = self.node_participation.get(round_num, set())
                leader = self.round_leaders.get(round_num)
                successful = round_num in self.successful_rounds
                
                result.update({
                    "commit_count": len(commits),
                    "reveal_count": len(reveals),
                    "participating_nodes": len(participating),
                    "leader": leader,
                    "successful": successful
                })
            except Exception as e:
                logging.error(f"Error getting round stats for round {round_num}: {e}")
                result["error"] = str(e)
            
            return result
    
    def cleanup_old_rounds(self, min_round: int) -> None:
        """
        Clean up data for old rounds to prevent memory leaks
        
        Args:
            min_round: Minimum round number to keep
        """
        if not isinstance(min_round, int) or min_round < 0:
            logging.warning(f"Invalid min_round for cleanup: {min_round}")
            return
            
        with WriteLockContext(self.rwlock):
            # Identify rounds to clean up
            rounds_to_clean = []
            
            for round_num in list(self.commits.keys()):
                if round_num < min_round:
                    rounds_to_clean.append(round_num)
            
            # Clean up old data
            for round_num in rounds_to_clean:
                if round_num in self.commits:
                    del self.commits[round_num]
                if round_num in self.reveals:
                    del self.reveals[round_num]
                if round_num in self.node_participation:
                    del self.node_participation[round_num]
                if round_num in self.round_leaders:
                    del self.round_leaders[round_num]
                if round_num in self.successful_rounds:
                    self.successful_rounds.remove(round_num)
            
            if rounds_to_clean:
                logging.info(f"Cleaned up {len(rounds_to_clean)} old consensus rounds")
    
    def get_reputation_report(self) -> Dict[str, Any]:
        """
        Generate a report on node reputations and consensus metrics
        
        Returns:
            Dictionary with reputation and consensus information
        """
        result = {
            "timestamp": time.time()
        }
        
        with ReadLockContext(self.rwlock):
            try:
                # Get current reputations
                reputations = self.node_reputation.get_all_reputations()
                
                # Get top and bottom 5 nodes by reputation
                sorted_nodes = sorted(reputations.items(), key=lambda x: x[1], reverse=True)
                top_nodes = sorted_nodes[:5]
                bottom_nodes = sorted_nodes[-5:] if len(sorted_nodes) >= 5 else []
                
                # Calculate success rate
                max_round = max(self.commits.keys()) if self.commits else 0
                recent_rounds = []
                for i in range(max(0, max_round - 10), max_round + 1):
                    if i >= 0:
                        recent_rounds.append(i)
                
                successful_count = sum(1 for r in recent_rounds if r in self.successful_rounds)
                success_rate = successful_count / len(recent_rounds) if recent_rounds else 0
                
                # Count leadership distribution
                leader_counts = collections.Counter(self.round_leaders.values())
                
                result.update({
                    "top_nodes": top_nodes,
                    "bottom_nodes": bottom_nodes,
                    "average_reputation": sum(reputations.values()) / len(reputations) if reputations else 0,
                    "node_count": len(reputations),
                    "consensus_success_rate": success_rate,
                    "leadership_distribution": dict(leader_counts.most_common(5)),
                    "reputation_influence": self.reputation_influence
                })
            except Exception as e:
                logging.error(f"Error generating reputation report: {e}")
                result["error"] = str(e)
            
            return result
    
    def get_random_beacon(self, round_num: int) -> str:
        """
        Generate a deterministic random beacon for a consensus round
        
        Args:
            round_num: Consensus round number
            
        Returns:
            Random beacon as a hex string
        """
        if not isinstance(round_num, int) or round_num < 0:
            logging.warning(f"Invalid round number for random beacon: {round_num}")
            return hashlib.sha256(str(round_num).encode()).hexdigest()
        
        try:
            # Combine all valid reveals with the round number
            with ReadLockContext(self.rwlock):
                round_reveals = self.reveals.get(round_num, {})
                if not round_reveals:
                    # Fallback if no reveals available
                    return hashlib.sha256(f"round-{round_num}".encode()).hexdigest()
                
                # Concatenate all reveals in sorted order for determinism
                combined_reveals = ""
                for node in sorted(round_reveals.keys()):
                    combined_reveals += round_reveals[node]
                
                # Create beacon from the combined reveals
                beacon_input = f"{round_num}-{combined_reveals}"
                return hashlib.sha256(beacon_input.encode()).hexdigest()
        except Exception as e:
            logging.error(f"Error generating random beacon for round {round_num}: {e}")
            # Fallback in case of error
            return hashlib.sha256(f"fallback-{round_num}".encode()).hexdigest()