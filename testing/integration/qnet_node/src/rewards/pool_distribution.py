"""
QNet Three-Pool Reward Distribution System
Pool #1: Base Emission (equal to all active nodes)
Pool #2: Transaction Fees (70% Super, 30% Full, 0% Light)
Pool #3: ActivationPool (equal to all active nodes from Phase 2 activation fees)
"""

import time
import math
import logging
import hashlib
from typing import Dict, List, Tuple, Optional
from dataclasses import dataclass, field
from enum import Enum

logger = logging.getLogger(__name__)

class NodeType(Enum):
    LIGHT = "light"
    FULL = "full"
    SUPER = "super"

@dataclass
class ActiveNode:
    """Active node information for reward calculation"""
    node_id: str
    node_type: NodeType
    reputation: float
    last_ping: int
    activation_timestamp: int

@dataclass
class PoolState:
    """State of reward pools"""
    pool1_base_emission: float = 0.0
    pool2_transaction_fees: float = 0.0
    pool3_activation_pool: float = 0.0
    last_distribution: int = 0
    distribution_round: int = 0

class PoolDistributor:
    """Manages three-pool reward distribution system with anti-abuse protection"""
    
    def __init__(self):
        # Pool state
        self.pool_state = PoolState()
        
        # Active nodes registry
        self.active_nodes: Dict[str, ActiveNode] = {}
        
        # Distribution history
        self.distribution_history: List[Dict] = []
        
        # Base emission parameters (CORRECTED: starts at 251,432.34 QNC every 4 hours to match whitepaper)
        self.initial_emission = 251_432.34
        self.emission_start = int(time.time())
        self.halving_interval = 4 * 365 * 24 * 60 * 60  # 4 years in seconds
        self.distribution_interval = 4 * 60 * 60  # 4 hours in seconds
        
        # Minimum reputation for NEW rewards by node type:
        # Light nodes: 0.0 (any reputation, mobile-friendly)
        # Full/Super nodes: 70.0 (must maintain network quality)
        self.min_reputation_light = 0.0
        self.min_reputation_full_super = 70.0
        
        # CORRECT LOGIC: Network pings nodes in randomized slots 
        self.reward_window = 4 * 60 * 60  # 4 hours: reward distribution window
        self.ping_slots = 240  # 240 slots (1 minute each) in 4-hour window
        self.ping_timeout = 60  # 60 seconds to respond to network ping
        self.ping_success_rate = 0.90  # 90% expected success rate
        
        # Network ping scheduling
        self.slot_duration = 60  # 1 minute per slot
        self.ping_randomization_enabled = True
        
        self.inactive_threshold = 24 * 60 * 60  # 24 hours: offline before pruning
        
        # Mobile-friendly restoration parameters
        self.quarantine_reputation = 25.0  # Below rewards threshold for new returns
        self.quarantine_duration = 7 * 24 * 60 * 60  # 7 days quarantine for long absence
        self.max_free_restorations = 10  # Generous limit for mobile users
        self.reactivation_required_after = 365 * 24 * 60 * 60  # 1 year absence requires reactivation
        self.restore_window = 30 * 24 * 60 * 60  # Reset restoration count every 30 days
        
        # Tracking for restoration abuse (mobile-friendly)
        self.pruned_nodes_history: Dict[str, Dict] = {}  # Track pruned nodes
        self.restoration_counts: Dict[str, Dict] = {}  # {node_id: {count: int, last_reset: timestamp}}
        self.quarantined_nodes: Dict[str, int] = {}  # node_id -> quarantine_until_timestamp
        
        logger.info(f"Network ping Pool distributor initialized. Base emission: {self.initial_emission} QNC every 4 hours")
    
    def get_node_ping_slot(self, node_id: str, node_type: NodeType = NodeType.LIGHT) -> int:
        """Get deterministic ping slot for node based on node_id hash and type"""
        if not self.ping_randomization_enabled:
            return 0
        
        # Create deterministic hash from node_id
        hash_bytes = hashlib.blake2b(node_id.encode(), digest_size=8).digest()
        hash_int = int.from_bytes(hash_bytes, byteorder='little')
        
        # Node-type specific slot assignment
        if node_type == NodeType.SUPER:
            # Super nodes get priority slots (first 24 slots only = 10x more frequent)
            assigned_slot = hash_int % 24
        else:
            # Full and Light nodes use all 240 slots
            assigned_slot = hash_int % self.ping_slots
        
        return assigned_slot
    
    def is_node_ping_slot_active(self, node_id: str, current_time: int) -> bool:
        """Check if current time is within this node's assigned ping slot"""
        if not self.ping_randomization_enabled:
            return True  # Always active if randomization disabled
        
        # Calculate current 4-hour window start
        window_start = current_time - (current_time % self.reward_window)
        
        # Get node's assigned slot
        assigned_slot = self.get_node_ping_slot(node_id)
        
        # Calculate slot time window
        slot_start = window_start + (assigned_slot * self.slot_duration)
        slot_end = slot_start + self.slot_duration
        
        # Check if current time is within the slot (or recently was)
        # Allow some grace period for network latency
        grace_period = 30  # 30 seconds grace
        return slot_start <= current_time <= (slot_end + grace_period)
    
    def add_active_node(self, node_id: str, node_type: NodeType, reputation: float) -> bool:
        """Add active node to reward distribution"""
        # Check minimum reputation based on node type
        min_rep = self.min_reputation_light if node_type == NodeType.LIGHT else self.min_reputation_full_super
        if reputation < min_rep:
            logger.warning(f"Node {node_id} ({node_type.value}) reputation {reputation} below minimum {min_rep}")
            return False
        
        self.active_nodes[node_id] = ActiveNode(
            node_id=node_id,
            node_type=node_type,
            reputation=reputation,
            last_ping=int(time.time()),
            activation_timestamp=int(time.time())
        )
        
        logger.info(f"Added active node: {node_id} type={node_type.value} reputation={reputation}")
        return True
    
    def update_node_ping(self, node_id: str) -> bool:
        """Update node ping (required for rewards)"""
        if node_id in self.active_nodes:
            self.active_nodes[node_id].last_ping = int(time.time())
            return True
        return False
    
    def get_eligible_nodes(self) -> List[ActiveNode]:
        """Get nodes eligible for NEW rewards (Light: any rep | Full/Super: rep >= 70, not in quarantine, responded to ping)"""
        current_time = int(time.time())
        eligible = []
        
        for node in self.active_nodes.values():
            # Check reputation requirement based on node type
            min_rep = self.min_reputation_light if node.node_type == NodeType.LIGHT else self.min_reputation_full_super
            if node.reputation < min_rep:
                continue
            
            # Check quarantine status
            if node.node_id in self.quarantined_nodes:
                quarantine_until = self.quarantined_nodes[node.node_id]
                if current_time < quarantine_until:
                    logger.debug(f"Node {node.node_id} in quarantine until {quarantine_until}")
                    continue
                else:
                    # Quarantine expired, remove from quarantine
                    del self.quarantined_nodes[node.node_id]
                    logger.info(f"Node {node.node_id} quarantine expired, now eligible for rewards")
            
            # Check if node responded to network ping in current reward window
            window_start = current_time - (current_time % self.reward_window)
            if node.last_ping < window_start:
                logger.debug(f"Node {node.node_id} type {node.node_type.value} did not respond to network ping in current window, excluded from rewards")
                continue
            
            eligible.append(node)
        
        return eligible
    
    def prune_inactive_nodes(self):
        """Remove nodes offline beyond inactive threshold and track their history"""
        current_time = int(time.time())
        pruned = []
        
        for node_id, node in list(self.active_nodes.items()):
            if current_time - node.last_ping > self.inactive_threshold:
                # Store node history before pruning
                offline_duration = current_time - node.last_ping
                self.pruned_nodes_history[node_id] = {
                    "pruned_at": current_time,
                    "last_reputation": node.reputation,
                    "node_type": node.node_type,
                    "offline_duration": offline_duration,
                    "activation_timestamp": node.activation_timestamp
                }
                
                del self.active_nodes[node_id]
                # Remove from quarantine if was quarantined
                if node_id in self.quarantined_nodes:
                    del self.quarantined_nodes[node_id]
                
                pruned.append(node_id)
                logger.info(f"Node {node_id} pruned after {offline_duration/3600:.1f}h offline, reputation {node.reputation:.1f}")
        
        if pruned:
            logger.info(f"Pruned {len(pruned)} inactive nodes after {self.inactive_threshold/3600:.1f}h threshold")
        
        return pruned
    
    def _get_restoration_count(self, node_id: str) -> int:
        """Get current restoration count with auto-reset every 30 days"""
        current_time = int(time.time())
        
        if node_id not in self.restoration_counts:
            return 0
        
        restoration_data = self.restoration_counts[node_id]
        last_reset = restoration_data.get("last_reset", 0)
        
        # Reset count if more than 30 days passed
        if current_time - last_reset > self.restore_window:
            self.restoration_counts[node_id] = {
                "count": 0,
                "last_reset": current_time
            }
            logger.info(f"Reset restoration count for node {node_id} (30 days passed)")
            return 0
        
        return restoration_data.get("count", 0)
    
    def _increment_restoration_count(self, node_id: str):
        """Increment restoration count for a node"""
        current_time = int(time.time())
        current_count = self._get_restoration_count(node_id)
        
        self.restoration_counts[node_id] = {
            "count": current_count + 1,
            "last_reset": self.restoration_counts.get(node_id, {}).get("last_reset", current_time)
        }

    def restore_node(self, node_id: str, node_type: NodeType, paid_reactivation: bool = False) -> Dict:
        """
        Restore previously pruned node with mobile-friendly anti-abuse protection
        Returns: {success: bool, reason: str, reputation: float, quarantine_until: Optional[int]}
        """
        if node_id in self.active_nodes:
            return {"success": False, "reason": "Node already active", "reputation": 0, "quarantine_until": None}
        
        current_time = int(time.time())
        
        # Check if node has history
        if node_id in self.pruned_nodes_history:
            history = self.pruned_nodes_history[node_id]
            absence_duration = current_time - history["pruned_at"]
            last_reputation = history["last_reputation"]
            
            # CRITICAL: Banned nodes must pay for reactivation
            if last_reputation < 10.0 and not paid_reactivation:
                return {
                    "success": False, 
                    "reason": f"Node was banned (reputation {last_reputation:.1f}), requires paid reactivation",
                    "reputation": 0,
                    "quarantine_until": None
                }
            
            # CRITICAL: Long absence requires paid reactivation (1 year)
            if absence_duration > self.reactivation_required_after and not paid_reactivation:
                return {
                    "success": False,
                    "reason": f"Absent for {absence_duration/(24*60*60):.1f} days (>{self.reactivation_required_after/(24*60*60)} days limit), requires paid reactivation",
                    "reputation": 0,
                    "quarantine_until": None
                }
            
            # MOBILE-FRIENDLY: Check restoration abuse (resets every 30 days)
            restoration_count = self._get_restoration_count(node_id)
            if restoration_count >= self.max_free_restorations and not paid_reactivation:
                return {
                    "success": False,
                    "reason": f"Exceeded free restoration limit ({restoration_count}/{self.max_free_restorations}) in 30-day window, requires paid reactivation",
                    "reputation": 0,
                    "quarantine_until": None
                }
            
            # Determine restoration reputation and quarantine
            if paid_reactivation:
                # Paid reactivation = normal reputation, no quarantine
                restoration_reputation = 70.0
                quarantine_until = None
                reason = "Paid reactivation successful"
            else:
                # Free restoration = quarantine period  
                restoration_reputation = self.quarantine_reputation  # 25.0 (below rewards threshold)
                quarantine_until = current_time + self.quarantine_duration  # 7 days
                reason = f"Free restoration in quarantine for {self.quarantine_duration/(24*60*60)} days (mobile-friendly: {restoration_count+1}/{self.max_free_restorations} in 30d window)"
            
        else:
            # New node (no history) - must pay for activation
            if not paid_reactivation:
                return {
                    "success": False,
                    "reason": "New node requires paid activation",
                    "reputation": 0,
                    "quarantine_until": None
                }
            
            restoration_reputation = 70.0
            quarantine_until = None
            reason = "New paid activation successful"
        
        # Create restored node
        self.active_nodes[node_id] = ActiveNode(
            node_id=node_id,
            node_type=node_type,
            reputation=restoration_reputation,
            last_ping=int(time.time()),
            activation_timestamp=int(time.time())
        )
        
        # Update restoration count (mobile-friendly with auto-reset)
        if not paid_reactivation:
            self._increment_restoration_count(node_id)
        
        # Add to quarantine if needed
        if quarantine_until is not None:
            self.quarantined_nodes[node_id] = quarantine_until
        
        logger.info(f"Node {node_id} restored: {reason}, reputation {restoration_reputation:.1f}")
        
        return {
            "success": True,
            "reason": reason,
            "reputation": restoration_reputation,
            "quarantine_until": quarantine_until
        }
    
    def get_node_status(self, node_id: str) -> Dict:
        """Get detailed status of a node for debugging"""
        current_time = int(time.time())
        
        if node_id in self.active_nodes:
            node = self.active_nodes[node_id]
            quarantine_until = self.quarantined_nodes.get(node_id)
            return {
                "active": True,
                "reputation": node.reputation,
                "eligible_for_rewards": (
                    node.reputation >= (self.min_reputation_light if node.node_type == NodeType.LIGHT else self.min_reputation_full_super)
                    and (quarantine_until is None or current_time >= quarantine_until)
                ),
                "last_ping": node.last_ping,
                "quarantine_until": quarantine_until,
                "restoration_count": self._get_restoration_count(node_id)
            }
        elif node_id in self.pruned_nodes_history:
            history = self.pruned_nodes_history[node_id]
            return {
                "active": False,
                "pruned_at": history["pruned_at"],
                "last_reputation": history["last_reputation"],
                "restoration_count": self._get_restoration_count(node_id),
                "can_restore_free": (
                    history["last_reputation"] >= 10.0 and
                    current_time - history["pruned_at"] <= self.reactivation_required_after and
                    self._get_restoration_count(node_id) < self.max_free_restorations
                )
            }
        else:
            return {"active": False, "history": "No history found"}

# Add remaining methods (calculate_current_emission, distribute_rewards, etc.)
# These remain the same as before... 