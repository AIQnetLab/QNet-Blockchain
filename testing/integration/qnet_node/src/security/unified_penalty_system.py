"""
Unified Penalty and Ban System for QNet
Consolidates all ping/ban/reputation mechanics into one consistent system
"""

import time
import logging
from typing import Dict, List, Set, Optional, Tuple
from enum import Enum
from dataclasses import dataclass

logger = logging.getLogger(__name__)

class ViolationType(Enum):
    """Types of violations that can result in penalties"""
    MISSED_PING = "missed_ping"
    INVALID_BLOCK = "invalid_block"
    DOUBLE_SIGN = "double_sign"
    NETWORK_SPAM = "network_spam"
    CONSENSUS_FAILURE = "consensus_failure"
    OFFLINE_EXTENDED = "offline_extended"

class PenaltyAction(Enum):
    """Actions that can be taken against violating nodes"""
    WARNING = "warning"
    REPUTATION_PENALTY = "reputation_penalty"
    REWARD_SUSPENSION = "reward_suspension"
    CONSENSUS_BAN = "consensus_ban"
    NETWORK_EXCLUSION = "network_exclusion"  # For inactivity - can return with reduced reputation
    TEMPORARY_BAN = "temporary_ban"  # For minor attacks - 7 days
    PERMANENT_BAN = "permanent_ban"  # For severe/repeated attacks

@dataclass
class ViolationRecord:
    """Record of a violation by a node"""
    node_id: str
    violation_type: ViolationType
    timestamp: int
    severity: float
    action_taken: PenaltyAction
    reputation_before: float
    reputation_after: float
    description: str

@dataclass
class NodePenaltyState:
    """Current penalty state of a node"""
    node_id: str
    node_type: str  # "super", "full", "light"
    wallet_address: str  # Associated wallet for duplicate prevention
    reputation: float
    last_ping: int
    total_violations: int
    active_penalties: Set[PenaltyAction]
    exclusion_timestamp: Optional[int]  # When excluded from network (inactivity)
    ban_expiry: Optional[int]  # None = no ban, timestamp = ban until (attacks)
    accumulated_rewards: float  # Unclaimed rewards - can be withdrawn even if banned
    violation_history: List[ViolationRecord]

class UnifiedPenaltySystem:
    """
    Unified system for handling all node penalties and bans
    PRODUCTION READY - No temporary solutions
    """
    
    # Unified thresholds (0-100 scale)
    INITIAL_REPUTATION = 50.0
    REWARDS_THRESHOLD = 40.0
    CONSENSUS_THRESHOLD = 70.0
    BAN_THRESHOLD = 10.0
    
    # CORRECT LOGIC: Network pings nodes in randomized slots
    REWARD_WINDOW = 4 * 60 * 60  # 4 hours: reward distribution window
    PING_SLOTS = 240  # 240 slots (1 minute each) in 4-hour window
    PING_TIMEOUT = 60  # 60 seconds to respond to network ping
    PING_SUCCESS_RATE = 0.90  # 90% expected success rate
    
    # CORRECTED LOGIC: Inactivity leads to EXCLUSION, not permanent ban
    INACTIVE_THRESHOLD = 7 * 24 * 60 * 60  # 7 days before network exclusion
    WARNING_THRESHOLD = 48 * 60 * 60       # 48 hours warning before exclusion
    GRACE_PERIOD = 12 * 60 * 60            # 12 hours grace period for server maintenance
    
    # RETURN TIMEOUTS (without payment) - differentiated by node type
    LIGHT_RETURN_TIMEOUT = 365 * 24 * 60 * 60   # 1 year for Light nodes
    FULL_RETURN_TIMEOUT = 90 * 24 * 60 * 60     # 90 days for Full nodes  
    SUPER_RETURN_TIMEOUT = 30 * 24 * 60 * 60    # 30 days for Super nodes
    
    # Penalty amounts
    PENALTY_AMOUNTS = {
        ViolationType.MISSED_PING: 1.0,
        ViolationType.INVALID_BLOCK: 5.0,
        ViolationType.DOUBLE_SIGN: 30.0,
        ViolationType.NETWORK_SPAM: 2.0,
        ViolationType.CONSENSUS_FAILURE: 10.0,
        ViolationType.OFFLINE_EXTENDED: 15.0,
    }
    
    def __init__(self):
        self.node_states = {}
        self.wallet_to_node = {}  # Track wallet to node mapping for duplicate prevention
        self.excluded_nodes = {}  # Track excluded nodes with return conditions
        self.violation_log = []  # Global violation log
        logger.info("Unified Penalty System initialized")
    
    def register_node(self, node_id: str, wallet_address: str, node_type: str = "light") -> Tuple[bool, str]:
        """
        Register new node with wallet duplicate prevention
        Returns: (success, message)
        """
        # Check if node already registered
        if node_id in self.node_states:
            return False, f"Node {node_id} already registered"
        
        # CRITICAL: Enforce 1 wallet = 1 node policy
        if wallet_address in self.wallet_to_node:
            existing_node = self.wallet_to_node[wallet_address]
            return False, f"Wallet {wallet_address} already has registered node: {existing_node}"
        
        # Create node state
        self.node_states[node_id] = NodePenaltyState(
            node_id=node_id,
            node_type=node_type,
            wallet_address=wallet_address,
            reputation=self.INITIAL_REPUTATION,
            last_ping=int(time.time()),
            total_violations=0,
            active_penalties=set(),
            exclusion_timestamp=None,
            ban_expiry=None,
            accumulated_rewards=0.0,
            violation_history=[]
        )
        
        # Track wallet to node mapping
        self.wallet_to_node[wallet_address] = node_id
        
        logger.info(f"Registered {node_type} node {node_id} for wallet {wallet_address} with initial reputation {self.INITIAL_REPUTATION}")
        return True, f"Node {node_id} successfully registered"

    def update_ping(self, node_id: str) -> bool:
        """Update node ping timestamp"""
        if node_id not in self.node_states:
            logger.warning(f"Unknown node {node_id} attempted ping")
            return False
        
        self.node_states[node_id].last_ping = int(time.time())
        return True
    
    def apply_violation(self, node_id: str, violation_type: ViolationType, 
                       description: str = "") -> ViolationRecord:
        """Apply violation penalty to node"""
        if node_id not in self.node_states:
            # Auto-register unknown nodes with penalty applied
            self.register_node(node_id)
        
        state = self.node_states[node_id]
        penalty_amount = self.PENALTY_AMOUNTS[violation_type]
        
        # Record state before penalty
        reputation_before = state.reputation
        
        # Apply reputation penalty
        state.reputation = max(0.0, state.reputation - penalty_amount)
        state.total_violations += 1
        
        # Determine action based on new reputation
        action = self._determine_penalty_action(state, violation_type)
        
        # Apply action
        self._apply_penalty_action(state, action)
        
        # Create violation record
        record = ViolationRecord(
            node_id=node_id,
            violation_type=violation_type,
            timestamp=int(time.time()),
            severity=penalty_amount,
            action_taken=action,
            reputation_before=reputation_before,
            reputation_after=state.reputation,
            description=description
        )
        
        state.violation_history.append(record)
        self.violation_log.append(record)
        
        logger.warning(f"Node {node_id} violated {violation_type.value}: "
                      f"reputation {reputation_before:.1f} -> {state.reputation:.1f}, "
                      f"action: {action.value}")
        
        return record
    
    def _determine_penalty_action(self, state: NodePenaltyState, 
                                violation_type: ViolationType) -> PenaltyAction:
        """Determine what penalty action to take based on violation type"""
        
        # CORRECTED LOGIC: Separate inactivity from attacks
        if violation_type in [ViolationType.MISSED_PING, ViolationType.OFFLINE_EXTENDED]:
            # Inactivity violations -> Network exclusion (can return)
            if state.reputation <= self.BAN_THRESHOLD:
                return PenaltyAction.NETWORK_EXCLUSION
            elif state.reputation < self.REWARDS_THRESHOLD:
                return PenaltyAction.REWARD_SUSPENSION
            else:
                return PenaltyAction.REPUTATION_PENALTY
        
        elif violation_type in [ViolationType.DOUBLE_SIGN, ViolationType.NETWORK_SPAM]:
            # Attack violations -> Bans (harsh penalties)
            if state.total_violations >= 3:  # Repeated attacks
                return PenaltyAction.PERMANENT_BAN
            elif state.reputation <= self.BAN_THRESHOLD:
                return PenaltyAction.TEMPORARY_BAN
            else:
                return PenaltyAction.CONSENSUS_BAN
        
        else:  # Other violations
            if state.reputation <= self.BAN_THRESHOLD:
                return PenaltyAction.CONSENSUS_BAN
            elif state.reputation < self.REWARDS_THRESHOLD:
                return PenaltyAction.REWARD_SUSPENSION
            else:
                return PenaltyAction.WARNING
    
    def _apply_penalty_action(self, state: NodePenaltyState, action: PenaltyAction):
        """Apply the determined penalty action"""
        current_time = int(time.time())
        state.active_penalties.add(action)
        
        if action == PenaltyAction.NETWORK_EXCLUSION:
            # Exclude from network (inactivity) - can return with reduced reputation
            state.exclusion_timestamp = current_time
            logger.info(f"Node {state.node_id} excluded from network due to inactivity")
            
        elif action == PenaltyAction.TEMPORARY_BAN:
            # 7 days ban for attacks
            state.ban_expiry = current_time + (7 * 24 * 60 * 60)
            logger.warning(f"Node {state.node_id} temporarily banned for 7 days")
            
        elif action == PenaltyAction.PERMANENT_BAN:
            # Permanent ban for repeated attacks
            state.reputation = 0.0
            state.ban_expiry = current_time + (100 * 365 * 24 * 60 * 60)  # 100 years = permanent
            logger.error(f"Node {state.node_id} PERMANENTLY BANNED for repeated attacks")
            
        elif action == PenaltyAction.CONSENSUS_BAN:
            # 24 hours consensus ban
            state.ban_expiry = current_time + (24 * 60 * 60)

    def add_rewards(self, node_id: str, amount: float) -> bool:
        """Add rewards to node (can be withdrawn even if banned)"""
        if node_id not in self.node_states:
            return False
        
        self.node_states[node_id].accumulated_rewards += amount
        return True

    def withdraw_rewards(self, node_id: str) -> Tuple[bool, float, str]:
        """
        Withdraw accumulated rewards (allowed even for banned nodes)
        Returns: (success, amount_withdrawn, message)
        """
        if node_id not in self.node_states:
            return False, 0.0, "Node not found"
        
        state = self.node_states[node_id]
        amount = state.accumulated_rewards
        
        if amount <= 0:
            return False, 0.0, "No rewards to withdraw"
        
        state.accumulated_rewards = 0.0
        logger.info(f"Node {node_id} withdrew {amount} accumulated rewards")
        return True, amount, f"Successfully withdrew {amount} rewards"

    def is_eligible_for_rewards(self, node_id: str) -> bool:
        """Check if node is eligible for rewards"""
        if node_id not in self.node_states:
            return False
        
        state = self.node_states[node_id]
        current_time = int(time.time())
        
        # Check reputation threshold
        if state.reputation < self.REWARDS_THRESHOLD:
            return False
        
        # Check if node responded to network ping in current reward window
        window_start = current_time - (current_time % self.REWARD_WINDOW)
        if state.last_ping < window_start:
            return False
        
        # Check active penalties
        if PenaltyAction.REWARD_SUSPENSION in state.active_penalties:
            return False
        
        # Check ban status
        if state.ban_expiry and current_time < state.ban_expiry:
            return False
        
        return True
    
    def is_eligible_for_consensus(self, node_id: str) -> bool:
        """Check if node can participate in consensus"""
        if node_id not in self.node_states:
            return False
        
        state = self.node_states[node_id]
        current_time = int(time.time())
        
        # Check reputation threshold
        if state.reputation < self.CONSENSUS_THRESHOLD:
            return False
        
        # Check active penalties
        if PenaltyAction.CONSENSUS_BAN in state.active_penalties:
            return False
        
        # Check ban status
        if state.ban_expiry and current_time < state.ban_expiry:
            return False
        
        # Check recent activity
        if current_time - state.last_ping > self.INACTIVE_THRESHOLD:
            return False
        
        return True
    
    def exclude_inactive_nodes(self) -> List[str]:
        """
        CORRECTED: Exclude (not ban) nodes that have been offline too long
        They can return with reduced reputation based on absence duration
        """
        current_time = int(time.time())
        excluded = []
        
        for node_id, state in list(self.node_states.items()):
            if current_time - state.last_ping > self.INACTIVE_THRESHOLD:
                # Apply offline violation and exclude from network
                self.apply_violation(node_id, ViolationType.OFFLINE_EXTENDED, 
                                   f"Offline for {(current_time - state.last_ping)/3600:.1f} hours")
                
                # Move to excluded nodes registry
                self.excluded_nodes[node_id] = {
                    'excluded_at': current_time,
                    'node_type': state.node_type,
                    'wallet_address': state.wallet_address,
                    'last_reputation': state.reputation,
                    'accumulated_rewards': state.accumulated_rewards
                }
                
                # Remove from active registry but keep wallet mapping
                del self.node_states[node_id]
                excluded.append(node_id)
        
        if excluded:
            logger.info(f"Excluded {len(excluded)} inactive nodes (can return with reduced reputation)")
        
        return excluded

    def restore_excluded_node(self, node_id: str, paid_reactivation: bool = False) -> Tuple[bool, str, float]:
        """
        Restore excluded node with reputation penalty based on absence duration
        Returns: (success, message, new_reputation)
        """
        if node_id not in self.excluded_nodes:
            return False, "Node not found in excluded registry", 0.0
        
        if node_id in self.node_states:
            return False, "Node already active", 0.0
        
        excluded_info = self.excluded_nodes[node_id]
        current_time = int(time.time())
        absence_duration = current_time - excluded_info['excluded_at']
        
        # Get return timeout based on node type
        node_type = excluded_info['node_type']
        if node_type == "super":
            return_timeout = self.SUPER_RETURN_TIMEOUT
        elif node_type == "full":
            return_timeout = self.FULL_RETURN_TIMEOUT
        else:  # light
            return_timeout = self.LIGHT_RETURN_TIMEOUT
        
        # Check if payment required
        if absence_duration > return_timeout and not paid_reactivation:
            days_absent = absence_duration / (24 * 60 * 60)
            max_days = return_timeout / (24 * 60 * 60)
            return False, f"Node absent for {days_absent:.1f} days (max {max_days} days free), requires paid reactivation", 0.0
        
        # Calculate reputation penalty based on absence duration
        penalty_factor = min(0.8, (absence_duration / return_timeout) * 0.5)  # Max 80% penalty
        new_reputation = max(25.0, excluded_info['last_reputation'] * (1 - penalty_factor))
        
        # Restore node with reduced reputation
        self.node_states[node_id] = NodePenaltyState(
            node_id=node_id,
            node_type=node_type,
            wallet_address=excluded_info['wallet_address'],
            reputation=new_reputation,
            last_ping=current_time,
            total_violations=0,
            active_penalties=set(),
            exclusion_timestamp=None,
            ban_expiry=None,
            accumulated_rewards=excluded_info['accumulated_rewards'],  # Keep accumulated rewards
            violation_history=[]
        )
        
        # Remove from excluded registry
        del self.excluded_nodes[node_id]
        
        logger.info(f"Restored excluded node {node_id} with reputation {new_reputation:.1f} (penalty: {penalty_factor*100:.1f}%)")
        return True, f"Node restored with reputation {new_reputation:.1f}", new_reputation

    def is_banned(self, node_id: str) -> Tuple[bool, Optional[str]]:
        """Check if node is banned (attacks) vs excluded (inactivity)"""
        if node_id not in self.node_states:
            if node_id in self.excluded_nodes:
                return False, "Node excluded due to inactivity (can be restored)"
            return False, None
        
        state = self.node_states[node_id]
        current_time = int(time.time())
        
        # Check attack-related bans
        if state.ban_expiry and current_time < state.ban_expiry:
            if state.ban_expiry > current_time + (50 * 365 * 24 * 60 * 60):  # More than 50 years = permanent
                return True, "PERMANENT BAN for repeated attacks"
            else:
                return True, f"Temporarily banned until {state.ban_expiry}"
        
        return False, None

    def prune_inactive_nodes(self) -> List[str]:
        """Legacy method - redirect to exclude_inactive_nodes"""
        return self.exclude_inactive_nodes()
    
    def cleanup_expired_bans(self) -> int:
        """Remove expired bans and penalties"""
        current_time = int(time.time())
        cleaned = 0
        
        for state in self.node_states.values():
            # Remove expired bans (but not permanent bans)
            if state.ban_expiry and current_time >= state.ban_expiry:
                # Check if it's not a permanent ban (100+ years)
                if state.ban_expiry < current_time + (50 * 365 * 24 * 60 * 60):
                    state.ban_expiry = None
                    state.active_penalties.discard(PenaltyAction.TEMPORARY_BAN)
                    state.active_penalties.discard(PenaltyAction.CONSENSUS_BAN)
                    cleaned += 1
        
        return cleaned
    
    def get_node_status(self, node_id: str) -> Optional[Dict]:
        """Get detailed status of a node (active or excluded)"""
        current_time = int(time.time())
        
        # Check active nodes
        if node_id in self.node_states:
            state = self.node_states[node_id]
            is_banned, ban_reason = self.is_banned(node_id)
            
            return {
                "node_id": node_id,
                "status": "active",
                "node_type": state.node_type,
                "wallet_address": state.wallet_address,
                "reputation": state.reputation,
                "last_ping": state.last_ping,
                "offline_hours": (current_time - state.last_ping) / 3600,
                "total_violations": state.total_violations,
                "accumulated_rewards": state.accumulated_rewards,
                "eligible_for_rewards": self.is_eligible_for_rewards(node_id),
                "eligible_for_consensus": self.is_eligible_for_consensus(node_id),
                "is_banned": is_banned,
                "ban_reason": ban_reason,
                "active_penalties": [p.value for p in state.active_penalties],
                "recent_violations": [
                    {
                        "type": v.violation_type.value,
                        "timestamp": v.timestamp,
                        "severity": v.severity,
                        "action": v.action_taken.value
                    }
                    for v in state.violation_history[-5:]  # Last 5 violations
                ]
            }
        
        # Check excluded nodes
        elif node_id in self.excluded_nodes:
            excluded_info = self.excluded_nodes[node_id]
            absence_duration = current_time - excluded_info['excluded_at']
            
            # Get return timeout
            node_type = excluded_info['node_type']
            if node_type == "super":
                return_timeout = self.SUPER_RETURN_TIMEOUT
            elif node_type == "full":
                return_timeout = self.FULL_RETURN_TIMEOUT
            else:
                return_timeout = self.LIGHT_RETURN_TIMEOUT
            
            can_return_free = absence_duration <= return_timeout
            
            return {
                "node_id": node_id,
                "status": "excluded",
                "node_type": excluded_info['node_type'],
                "wallet_address": excluded_info['wallet_address'],
                "excluded_at": excluded_info['excluded_at'],
                "absence_days": absence_duration / (24 * 60 * 60),
                "last_reputation": excluded_info['last_reputation'],
                "accumulated_rewards": excluded_info['accumulated_rewards'],
                "can_return_free": can_return_free,
                "max_free_absence_days": return_timeout / (24 * 60 * 60),
                "reason": "Network exclusion due to inactivity"
            }
        
        return None
    
    def get_system_stats(self) -> Dict:
        """Get overall system statistics with corrected logic"""
        active_nodes = len(self.node_states)
        excluded_nodes = len(self.excluded_nodes)
        total_registered = active_nodes + excluded_nodes
        
        banned_nodes = sum(1 for node_id in self.node_states if self.is_banned(node_id)[0])
        reward_eligible = sum(1 for node_id in self.node_states if self.is_eligible_for_rewards(node_id))
        consensus_eligible = sum(1 for node_id in self.node_states if self.is_eligible_for_consensus(node_id))
        
        # Count excluded nodes by type
        excluded_by_type = {"light": 0, "full": 0, "super": 0}
        for excluded_info in self.excluded_nodes.values():
            node_type = excluded_info['node_type']
            if node_type in excluded_by_type:
                excluded_by_type[node_type] += 1
        
        return {
            "active_nodes": active_nodes,
            "excluded_nodes": excluded_nodes,
            "total_registered": total_registered,
            "banned_nodes": banned_nodes,
            "reward_eligible": reward_eligible,
            "consensus_eligible": consensus_eligible,
            "total_violations": len(self.violation_log),
            "excluded_by_type": excluded_by_type,
            "unique_wallets": len(self.wallet_to_node),
            "thresholds": {
                "rewards": self.REWARDS_THRESHOLD,
                "consensus": self.CONSENSUS_THRESHOLD,
                "ban": self.BAN_THRESHOLD
            },
            "timeouts": {
                "reward_window_hours": self.REWARD_WINDOW / 3600,
                "inactive_threshold_hours": self.INACTIVE_THRESHOLD / 3600,
                "light_return_days": self.LIGHT_RETURN_TIMEOUT / (24 * 60 * 60),
                "full_return_days": self.FULL_RETURN_TIMEOUT / (24 * 60 * 60),
                "super_return_days": self.SUPER_RETURN_TIMEOUT / (24 * 60 * 60)
            }
        } 