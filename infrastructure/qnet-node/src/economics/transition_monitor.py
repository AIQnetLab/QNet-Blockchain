"""
Transition Monitor for QNA -> QNC Phase Change
Monitors Solana burn data and network age to determine transition timing
"""

import time
from typing import Dict, Tuple, Optional
from dataclasses import dataclass
import logging

logger = logging.getLogger(__name__)

@dataclass
class TransitionState:
    """Current state of QNA->QNC transition"""
    is_transitioned: bool
    transition_timestamp: Optional[int]
    trigger_reason: Optional[str]
    total_burned_at_transition: Optional[int]
    network_age_at_transition: Optional[float]

class TransitionMonitor:
    """
    Monitors conditions for QNA->QNC transition
    Checks both burn percentage and time elapsed
    """
    
    def __init__(self, launch_timestamp: int):
        self.launch_timestamp = launch_timestamp
        self.total_qna_supply = 1_000_000_000  # 1 billion (Pump.fun standard)
        self.burn_threshold_percent = 90.0
        self.max_years = 5.0
        
        # Transition state
        self.transition_state = TransitionState(
            is_transitioned=False,
            transition_timestamp=None,
            trigger_reason=None,
            total_burned_at_transition=None,
            network_age_at_transition=None
        )
        
    def check_transition_conditions(self, total_burned: int) -> Tuple[bool, str]:
        """
        Check if transition conditions are met
        
        Args:
            total_burned: Total QNA burned from Solana
            
        Returns:
            (should_transition, reason)
        """
        
        # If already transitioned, return current state
        if self.transition_state.is_transitioned:
            return False, f"Already transitioned at {self.transition_state.transition_timestamp}"
        
        current_time = int(time.time())
        
        # Check burn percentage
        burn_percentage = (total_burned / self.total_qna_supply) * 100
        if burn_percentage >= self.burn_threshold_percent:
            return True, f"Burn threshold reached: {burn_percentage:.2f}% >= {self.burn_threshold_percent}%"
        
        # Check time elapsed
        years_elapsed = (current_time - self.launch_timestamp) / (365 * 24 * 3600)
        if years_elapsed >= self.max_years:
            return True, f"Time limit reached: {years_elapsed:.2f} years >= {self.max_years} years"
        
        # Not ready for transition
        remaining_burn = self.burn_threshold_percent - burn_percentage
        remaining_years = self.max_years - years_elapsed
        
        return False, f"Not ready: {burn_percentage:.2f}% burned, {years_elapsed:.2f} years elapsed"
    
    def execute_transition(self, total_burned: int, trigger_reason: str) -> bool:
        """
        Execute the transition to QNC phase
        
        Args:
            total_burned: Total burned at transition time
            trigger_reason: Why transition was triggered
            
        Returns:
            Success status
        """
        
        if self.transition_state.is_transitioned:
            logger.warning("Attempted to transition when already transitioned")
            return False
        
        current_time = int(time.time())
        years_elapsed = (current_time - self.launch_timestamp) / (365 * 24 * 3600)
        
        # Record transition
        self.transition_state = TransitionState(
            is_transitioned=True,
            transition_timestamp=current_time,
            trigger_reason=trigger_reason,
            total_burned_at_transition=total_burned,
            network_age_at_transition=years_elapsed
        )
        
        logger.info(f"QNA->QNC transition executed: {trigger_reason}")
        logger.info(f"Total burned: {total_burned:,} QNA")
        logger.info(f"Network age: {years_elapsed:.2f} years")
        
        return True
    
    def get_transition_status(self, total_burned: int) -> Dict:
        """
        Get detailed transition status
        
        Args:
            total_burned: Current total burned
        """
        
        current_time = int(time.time())
        years_elapsed = (current_time - self.launch_timestamp) / (365 * 24 * 3600)
        burn_percentage = (total_burned / self.total_qna_supply) * 100
        
        if self.transition_state.is_transitioned:
            return {
                "phase": "QNC",
                "transitioned": True,
                "transition_timestamp": self.transition_state.transition_timestamp,
                "trigger_reason": self.transition_state.trigger_reason,
                "burned_at_transition": self.transition_state.total_burned_at_transition,
                "age_at_transition": self.transition_state.network_age_at_transition
            }
        else:
            return {
                "phase": "QNA",
                "transitioned": False,
                "current_burn_percentage": burn_percentage,
                "current_network_age": years_elapsed,
                "burn_threshold": self.burn_threshold_percent,
                "time_threshold_years": self.max_years,
                "burn_remaining": max(0, self.burn_threshold_percent - burn_percentage),
                "years_remaining": max(0, self.max_years - years_elapsed)
            }
    
    def should_use_qnc_contract(self) -> bool:
        """
        Simple check if QNC contract should be used for activations
        """
        return self.transition_state.is_transitioned
    
    def get_activation_method(self) -> str:
        """
        Get current activation method
        """
        return "QNC_BURN" if self.transition_state.is_transitioned else "QNA_BURN"


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
            # QNA phase - dynamic pricing based on burn progress
            from qna_burn_model import QNABurnModel
            model = QNABurnModel()
            price = model.calculate_node_price(node_type, total_burned)
            
            return {
                "phase": "QNA",
                "token": "QNA",
                "amount": price,
                "method": "burn_qna_solana",
                "contract": "solana"
            } 