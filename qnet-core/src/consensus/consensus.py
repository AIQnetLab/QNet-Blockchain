# consensus.py - Implementation of commit-reveal consensus mechanism for QNet

import os
import json
import logging
import time
import hashlib
import base64
import random
import string
from typing import Dict, Any, Optional, Tuple, List, Union, Set

# Import key manager for cryptographic operations
from key_manager import get_key_manager

class CommitRevealConsensus:
    """
    Implementation of commit-reveal consensus mechanism for QNet.
    This helps prevent front-running and Sybil attacks.
    """
    
    def __init__(self, config=None):
        """
        Initialize the consensus mechanism.
        
        Args:
            config: Configuration object or dictionary
        """
        # Default configuration
        self.config = {
            'commit_window_seconds': int(os.environ.get('QNET_COMMIT_WINDOW_SECONDS', '60')),
            'reveal_window_seconds': int(os.environ.get('QNET_REVEAL_WINDOW_SECONDS', '30')),
            'min_reveals_ratio': float(os.environ.get('QNET_MIN_REVEALS_RATIO', '0.67')),  # 2/3 of commits
            'max_round_time_seconds': int(os.environ.get('QNET_MAX_ROUND_TIME_SECONDS', '120')),
            'difficulty_adjustment_window': int(os.environ.get('QNET_DIFFICULTY_ADJUSTMENT_WINDOW', '10')),
            'target_round_time_seconds': int(os.environ.get('QNET_TARGET_ROUND_TIME_SECONDS', '60')),
            'min_participants': int(os.environ.get('QNET_MIN_PARTICIPANTS', '3')),
            'sybil_resistance_enabled': os.environ.get('QNET_SYBIL_RESISTANCE', 'true').lower() == 'true',
        }
        
        # Override with provided config if available
        if config:
            if hasattr(config, '__getitem__'):
                # Dictionary-like object
                for key, value in self.config.items():
                    if key in config:
                        self.config[key] = config[key]
            else:
                # Attribute-based object
                for key in self.config.keys():
                    if hasattr(config, key):
                        self.config[key] = getattr(config, key)
        
        # Initialize key manager
        self.key_manager = get_key_manager()
        
        # State for current round
        self.current_round = 0
        self.round_state = self._create_empty_round_state()
        self.participants = set()
        
        # Difficulty tracking
        self.current_difficulty = 1.0
        self.round_times = []
        
        logging.info("Commit-Reveal consensus mechanism initialized")
        logging.info(f"Commit window: {self.config['commit_window_seconds']} seconds")
        logging.info(f"Reveal window: {self.config['reveal_window_seconds']} seconds")
    
    def _create_empty_round_state(self) -> Dict[str, Any]:
        """
        Create empty state for a new round.
        
        Returns:
            Dictionary with round state
        """
        return {
            'round_number': self.current_round,
            'start_time': int(time.time()),
            'phase': 'commit',
            'commits': {},  # node_id -> commit_hash
            'reveals': {},  # node_id -> revealed_value
            'commit_end_time': int(time.time()) + self.config['commit_window_seconds'],
            'reveal_end_time': int(time.time()) + self.config['commit_window_seconds'] + self.config['reveal_window_seconds'],
            'round_winner': None,
            'winning_value': None,
            'difficulty': self.current_difficulty,
            'status': 'in_progress'
        }
    
    def start_new_round(self, round_number: int) -> Dict[str, Any]:
        """
        Start a new consensus round.
        
        Args:
            round_number: Round number to start
            
        Returns:
            Dictionary with round state
        """
        # Check if round is already in progress
        if self.current_round == round_number and self.round_state['status'] == 'in_progress':
            return self.round_state
        
        # Finalize previous round if needed
        if self.round_state['status'] == 'in_progress':
            self._finalize_round(force=True)
        
        # Adjust difficulty based on past rounds
        self._adjust_difficulty()
        
        # Create new round state
        self.current_round = round_number
        self.round_state = self._create_empty_round_state()
        self.round_state['round_number'] = round_number
        self.participants.clear()
        
        logging.info(f"Started new consensus round {round_number}")
        
        return self.round_state
    
    def submit_commit(self, node_id: str, commit_hash: str, signature: str) -> Tuple[bool, str]:
        """
        Submit a commitment for the current round.
        
        Args:
            node_id: Node identifier
            commit_hash: Hash of the committed value
            signature: Signature of the commitment
            
        Returns:
            Tuple of (success, message)
        """
        # Verify current phase
        if self.round_state['phase'] != 'commit':
            return False, "Commit phase has ended"
        
        # Check if commit window has ended
        if int(time.time()) > self.round_state['commit_end_time']:
            # Move to reveal phase
            self._transition_to_reveal_phase()
            return False, "Commit phase has ended"
        
        # Verify signature
        message = f"{self.current_round}:{commit_hash}"
        if not self.key_manager.verify_signature(message, signature, node_id):
            return False, "Invalid signature"
        
        # Add commit
        self.round_state['commits'][node_id] = {
            'hash': commit_hash,
            'timestamp': int(time.time()),
            'signature': signature
        }
        
        # Add to participants
        self.participants.add(node_id)
        
        logging.info(f"Accepted commit from node {node_id} for round {self.current_round}")
        
        # Check if we should automatically transition to reveal phase
        active_nodes_count = len(self.participants)
        if len(self.round_state['commits']) >= active_nodes_count:
            # All active nodes have committed
            logging.info(f"All active nodes ({active_nodes_count}) have committed, transitioning to reveal phase")
            self._transition_to_reveal_phase()
        
        return True, "Commit accepted"
    
    def submit_reveal(self, node_id: str, value: str, nonce: str) -> Tuple[bool, str]:
        """
        Submit a reveal for the current round.
        
        Args:
            node_id: Node identifier
            value: Revealed value
            nonce: Random nonce used in commitment
            
        Returns:
            Tuple of (success, message)
        """
        # Verify current phase
        if self.round_state['phase'] != 'reveal':
            return False, "Reveal phase has not started or has ended"
        
        # Check if reveal window has ended
        if int(time.time()) > self.round_state['reveal_end_time']:
            # Finalize round
            self._finalize_round()
            return False, "Reveal phase has ended"
        
        # Check if node submitted a commit
        if node_id not in self.round_state['commits']:
            return False, "No corresponding commit found"
        
        # Verify that the revealed value matches the commitment
        commit_data = self.round_state['commits'][node_id]
        expected_hash = self._compute_commit_hash(value, nonce, self.current_round, node_id)
        
        if expected_hash != commit_data['hash']:
            return False, "Revealed value does not match commitment"
        
        # Add reveal
        self.round_state['reveals'][node_id] = {
            'value': value,
            'nonce': nonce,
            'timestamp': int(time.time())
        }
        
        logging.info(f"Accepted reveal from node {node_id} for round {self.current_round}")
        
        # Check if we have enough reveals to finalize the round
        min_reveals = max(
            int(len(self.round_state['commits']) * self.config['min_reveals_ratio']),
            self.config['min_participants']
        )
        
        if len(self.round_state['reveals']) >= min_reveals:
            # We have enough reveals to finalize
            logging.info(f"Received {len(self.round_state['reveals'])} reveals (min: {min_reveals}), finalizing round")
            self._finalize_round()
        
        return True, "Reveal accepted"
    
    def _transition_to_reveal_phase(self) -> None:
        """Transition from commit phase to reveal phase."""
        if self.round_state['phase'] != 'commit':
            return
            
        self.round_state['phase'] = 'reveal'
        self.round_state['reveal_end_time'] = int(time.time()) + self.config['reveal_window_seconds']
        
        logging.info(f"Transitioned to reveal phase for round {self.current_round}")
    
    def _finalize_round(self, force: bool = False) -> None:
        """
        Finalize the current round and determine the winner.
        
        Args:
            force: Force finalization even with insufficient reveals
        """
        if self.round_state['status'] != 'in_progress':
            return
            
        # Check if we have minimum required reveals
        min_reveals = max(
            int(len(self.round_state['commits']) * self.config['min_reveals_ratio']),
            self.config['min_participants']
        )
        
        if len(self.round_state['reveals']) < min_reveals and not force:
            logging.warning(f"Not enough reveals ({len(self.round_state['reveals'])}/{min_reveals}) to finalize round {self.current_round}")
            return
            
        # Calculate round winner
        if len(self.round_state['reveals']) > 0:
            self._calculate_round_winner()
        else:
            logging.warning(f"No reveals received for round {self.current_round}")
        
        # Record round time
        round_time = int(time.time()) - self.round_state['start_time']
        self.round_times.append(round_time)
        if len(self.round_times) > self.config['difficulty_adjustment_window']:
            self.round_times.pop(0)
        
        # Mark round as complete
        self.round_state['status'] = 'complete'
        self.round_state['end_time'] = int(time.time())
        self.round_state['round_time'] = round_time
        
        logging.info(f"Finalized round {self.current_round} in {round_time} seconds")
        if self.round_state['round_winner']:
            logging.info(f"Round winner: {self.round_state['round_winner']}")
        else:
            logging.info("No winner determined for this round")
    
    def _calculate_round_winner(self) -> None:
        """Calculate the winner of the current round based on revealed values."""
        if not self.round_state['reveals']:
            return
            
        # Combine all revealed values
        combined_value = ""
        for node_id, reveal_data in sorted(self.round_state['reveals'].items()):
            combined_value += reveal_data['value']
        
        # Hash the combined value to get a pseudorandom result
        result_hash = hashlib.sha256(combined_value.encode()).hexdigest()
        
        # Normalize the hash to a value between 0 and 1
        normalized_value = int(result_hash, 16) / (2**256 - 1)
        
        # Apply difficulty threshold
        threshold = 1.0 / self.current_difficulty
        if normalized_value > threshold:
            # No winner this round (difficulty check failed)
            self.round_state['winning_value'] = normalized_value
            return
        
        # Select the winner based on the normalized value
        eligible_nodes = list(self.round_state['reveals'].keys())
        if not eligible_nodes:
            return
            
        winner_index = int(normalized_value * len(eligible_nodes))
        winner_node_id = eligible_nodes[winner_index]
        
        self.round_state['round_winner'] = winner_node_id
        self.round_state['winning_value'] = normalized_value
    
    def _adjust_difficulty(self) -> None:
        """Adjust difficulty based on recent round times."""
        if not self.round_times or len(self.round_times) < self.config['difficulty_adjustment_window'] // 2:
            return
            
        avg_round_time = sum(self.round_times) / len(self.round_times)
        target_time = self.config['target_round_time_seconds']
        
        # Adjust difficulty to get closer to target time
        # If rounds are too fast, increase difficulty
        # If rounds are too slow, decrease difficulty
        adjustment_factor = target_time / max(1, avg_round_time)
        
        # Limit adjustment to max 10% in either direction
        adjustment_factor = max(0.9, min(1.1, adjustment_factor))
        
        self.current_difficulty *= adjustment_factor
        
        # Ensure difficulty is between 1.0 and 100.0
        self.current_difficulty = max(1.0, min(100.0, self.current_difficulty))
        
        logging.info(f"Adjusted difficulty to {self.current_difficulty:.2f} (avg round time: {avg_round_time:.2f}s)")
    
    def _compute_commit_hash(self, value: str, nonce: str, round_number: int, node_id: str) -> str:
        """
        Compute commitment hash from value and nonce.
        
        Args:
            value: Value to commit
            nonce: Random nonce
            round_number: Current round number
            node_id: Node identifier
            
        Returns:
            Commitment hash
        """
        # Combine value, nonce, round number, and node ID to prevent replay attacks
        data = f"{value}:{nonce}:{round_number}:{node_id}"
        return hashlib.sha256(data.encode()).hexdigest()
    
    def get_round_state(self) -> Dict[str, Any]:
        """
        Get current round state.
        
        Returns:
            Dictionary with round state
        """
        # Check if phase transition or round finalization is needed
        current_time = int(time.time())
        
        if self.round_state['status'] == 'in_progress':
            if self.round_state['phase'] == 'commit' and current_time > self.round_state['commit_end_time']:
                self._transition_to_reveal_phase()
                
            if self.round_state['phase'] == 'reveal' and current_time > self.round_state['reveal_end_time']:
                self._finalize_round()
                
            if current_time > self.round_state['start_time'] + self.config['max_round_time_seconds']:
                # Round took too long, force finalization
                self._finalize_round(force=True)
        
        return self.round_state
    
    def generate_commit(self, node_id: str) -> Tuple[str, str, str]:
        """
        Generate a commitment for the current round.
        
        Args:
            node_id: Node identifier
            
        Returns:
            Tuple of (commit_hash, value, nonce)
        """
        # Generate random value and nonce
        value = ''.join(random.choices(string.ascii_letters + string.digits, k=32))
        nonce = ''.join(random.choices(string.ascii_letters + string.digits, k=16))
        
        # Compute hash
        commit_hash = self._compute_commit_hash(value, nonce, self.current_round, node_id)
        
        return commit_hash, value, nonce
    
    def sign_commitment(self, node_id: str, commit_hash: str) -> str:
        """
        Sign a commitment for submission.
        
        Args:
            node_id: Node identifier
            commit_hash: Hash of the commitment
            
        Returns:
            Signature of the commitment
        """
        message = f"{self.current_round}:{commit_hash}"
        return self.key_manager.sign_message(message, node_id)
    
    def is_sybil_resistant(self) -> bool:
        """
        Check if the consensus is Sybil resistant.
        
        Returns:
            True if Sybil resistance is enabled
        """
        return self.config['sybil_resistance_enabled']


# Helper function to get singleton instance
_consensus_instance = None

def get_consensus(config=None) -> CommitRevealConsensus:
    """
    Get or create the singleton consensus instance.
    
    Args:
        config: Optional configuration
        
    Returns:
        CommitRevealConsensus instance
    """
    global _consensus_instance
    if _consensus_instance is None:
        _consensus_instance = CommitRevealConsensus(config)
    return _consensus_instance