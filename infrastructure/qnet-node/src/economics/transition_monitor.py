"""
Transition Monitor for 1DEV -> QNC Phase Change
Monitors conditions for transitioning from 1DEV burns to QNC payments
"""

from dataclasses import dataclass
from typing import Dict, Optional
import time
import logging

logger = logging.getLogger(__name__)

@dataclass
class TransitionState:
    """Current state of 1DEV->QNC transition"""
    is_transitioned: bool = False
    transition_timestamp: Optional[int] = None
    trigger_reason: Optional[str] = None  # "burn_threshold" or "time_limit"
    final_onedev_burned: Optional[int] = None

class TransitionMonitor:
    """
    Monitors conditions for 1DEV->QNC transition
    
    Transition occurs when:
    1. 90% of 1DEV supply is burned (900M out of 1B)
    2. OR 5 years have elapsed since network launch
    """
    
    def __init__(self, network_launch_timestamp: int = None):
        self.network_launch_timestamp = network_launch_timestamp or int(time.time())
        self.transition_state = TransitionState()
        
        # Transition parameters
        self.onedev_total_supply = 1_000_000_000  # 1 billion
        self.burn_threshold_percent = 90.0  # 90%
        self.time_limit_years = 5
        
    def check_transition_conditions(
        self,
        total_burned: int,
        current_timestamp: int = None
    ) -> tuple[bool, str]:
        """
        Check if transition conditions are met
        
        Args:
            total_burned: Total 1DEV burned from Solana
            current_timestamp: Current time (defaults to now)
            
        Returns:
            (should_transition, reason)
        """
        current_time = current_timestamp or int(time.time())
        
        # Check burn threshold (90% of supply)
        burn_threshold = (self.burn_threshold_percent / 100) * self.onedev_total_supply
        if total_burned >= burn_threshold:
            return True, f"Burn threshold reached: {total_burned:,} >= {burn_threshold:,} 1DEV"
        
        # Check time limit (5 years)
        elapsed_seconds = current_time - self.network_launch_timestamp
        elapsed_years = elapsed_seconds / (365.25 * 24 * 3600)  # Account for leap years
        
        if elapsed_years >= self.time_limit_years:
            return True, f"Time limit reached: {elapsed_years:.1f} >= {self.time_limit_years} years"
        
        # No transition yet
        burn_percent = (total_burned / self.onedev_total_supply) * 100
        time_remaining = self.time_limit_years - elapsed_years
        
        return False, f"No transition: {burn_percent:.1f}% burned, {time_remaining:.1f} years remaining"
    
    def execute_transition(
        self,
        total_burned: int,
        trigger_reason: str,
        timestamp: int = None
    ) -> bool:
        """
        Execute the transition to QNC phase
        
        Args:
            total_burned: Final 1DEV burn amount
            trigger_reason: Why transition occurred
            timestamp: When transition occurred
            
        Returns:
            Success status
        """
        if self.transition_state.is_transitioned:
            logger.warning("Transition already executed")
            return False
        
        transition_time = timestamp or int(time.time())
        
        # Update transition state
        self.transition_state.is_transitioned = True
        self.transition_state.transition_timestamp = transition_time
        self.transition_state.trigger_reason = trigger_reason
        self.transition_state.final_onedev_burned = total_burned
        
        logger.info(f"1DEV->QNC transition executed: {trigger_reason}")
        logger.info(f"Total burned: {total_burned:,} 1DEV")
        logger.info(f"Transition time: {transition_time}")
        
        # TODO: Notify other systems about transition
        # - Update pricing models
        # - Activate QNC payment system
        # - Disable 1DEV burn tracking
        
        return True
    
    def get_transition_status(self) -> Dict:
        """Get current transition status"""
        return {
            "is_transitioned": self.transition_state.is_transitioned,
            "transition_timestamp": self.transition_state.transition_timestamp,
            "trigger_reason": self.transition_state.trigger_reason,
            "final_onedev_burned": self.transition_state.final_onedev_burned,
            "network_launch": self.network_launch_timestamp,
            "onedev_total_supply": self.onedev_total_supply,
            "burn_threshold_percent": self.burn_threshold_percent,
            "time_limit_years": self.time_limit_years
        }
    
    def get_progress_metrics(self, total_burned: int) -> Dict:
        """Get detailed progress metrics"""
        current_time = int(time.time())
        
        # Burn progress
        burn_ratio = total_burned / self.onedev_total_supply
        burn_percent = burn_ratio * 100
        
        # Time progress
        elapsed_seconds = current_time - self.network_launch_timestamp
        elapsed_years = elapsed_seconds / (365.25 * 24 * 3600)
        time_progress_percent = (elapsed_years / self.time_limit_years) * 100
        
        # Which condition is closer?
        burn_distance = (90.0 - burn_percent) / 90.0  # 0 = reached, 1 = far
        time_distance = (self.time_limit_years - elapsed_years) / self.time_limit_years
        
        closer_condition = "burn" if burn_distance < time_distance else "time"
        
        return {
            "phase": "1DEV",
            "burn_progress": {
                "total_burned": total_burned,
                "burn_ratio": burn_ratio,
                "burn_percent": burn_percent,
                "target_percent": 90.0,
                "remaining_to_target": max(0, 900_000_000 - total_burned)
            },
            "time_progress": {
                "elapsed_years": elapsed_years,
                "elapsed_percent": min(100, time_progress_percent),
                "target_years": self.time_limit_years,
                "remaining_years": max(0, self.time_limit_years - elapsed_years)
            },
            "transition_prediction": {
                "closer_condition": closer_condition,
                "estimated_days_to_transition": self._estimate_transition_time(total_burned)
            }
        }
    
    def should_use_qnc_contract(self) -> bool:
        """Check if we should use QNC contract instead of 1DEV burns"""
        return self.transition_state.is_transitioned
    
    def _estimate_transition_time(self, total_burned: int) -> Optional[int]:
        """Estimate days until transition (simplified)"""
        # This would use burn rate analysis in production
        # For now, return None (unknown)
        return None

# Integration with node activation
class NodeActivationRouter:
    """
    Routes node activation requests to appropriate method based on phase
    """
    
    def __init__(self, transition_monitor: TransitionMonitor):
        self.transition_monitor = transition_monitor
        
    def get_activation_requirements(
        self, 
        node_type: str, 
        total_burned: int,
        total_nodes: int
    ) -> Dict:
        """
        Get activation requirements based on current phase
        """
        
        if self.transition_monitor.should_use_qnc_contract():
            # QNC phase - fixed prices with network size multiplier
            base_prices = {
                "light": 5_000,
                "full": 7_500,
                "super": 10_000
            }
            
            # Apply network size multiplier
            if total_nodes < 100_000:
                multiplier = 0.5
            elif total_nodes < 1_000_000:
                multiplier = 1.0
            elif total_nodes < 10_000_000:
                multiplier = 2.0
            else:
                multiplier = 3.0
                
            price = int(base_prices[node_type] * multiplier)
            
            return {
                "phase": "QNC",
                "token": "QNC",
                "amount": price,
                "method": "burn_qnc",
                "contract": "qnet_native"
            }
        else:
            # 1DEV phase - dynamic pricing based on burn progress
            from onedev_burn_model import OneDEVBurnModel
            model = OneDEVBurnModel()
            price = model.calculate_node_price(node_type, total_burned)
            
            return {
                "phase": "1DEV",
                "token": "1DEV",
                "amount": price,
                "method": "burn_onedev_solana",
                "contract": "solana"
            } 