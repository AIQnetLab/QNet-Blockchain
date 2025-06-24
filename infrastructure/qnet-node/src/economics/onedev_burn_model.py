"""
1DEV Burn Model - Dynamic burning threshold based on supply burned
As discussed: Start with 1,500 1DEV, decrease as more is burned
"""

import math
from typing import Dict, Tuple
from dataclasses import dataclass
from enum import Enum

class NodeType(Enum):
    LIGHT = "light"
    FULL = "full"
    SUPER = "super"

@dataclass
class BurnModelConfig:
    """Configuration for 1DEV burn model"""
    # Starting prices (at 0% burned) - ALL SAME PRICE
    light_node_start: float = 1500
    full_node_start: float = 1500
    super_node_start: float = 1500
    
    # Minimum prices (at 90% burned) - ALL SAME PRICE
    light_node_min: float = 150
    full_node_min: float = 150
    super_node_min: float = 150
    
    # Transition parameters
    burn_threshold_percent: float = 90.0  # Transition at 90% burned
    max_transition_years: float = 5.0     # Or after 5 years
    total_onedev_supply: float = 1_000_000_000  # 1 billion 1DEV (Pump.fun standard)
    
    # Price curve parameters
    decay_factor: float = 3.0  # Controls steepness of price decay
    round_to_nearest: int = 50  # Round prices to nearest 50 1DEV

class OneDevBurnCalculator:
    """Calculates 1DEV burn requirements based on current burn progress"""
    
    def __init__(self, config: BurnModelConfig = None):
        self.config = config or BurnModelConfig()
    
    def calculate_burn_requirement(
        self,
        node_type: NodeType,
        total_one_dev_burned: float,
        current_qnc_price: float = None
    ) -> Dict[str, any]:
        """
        Calculate 1DEV burn requirement for node activation
        
        Args:
            node_type: Type of node to activate
            total_one_dev_burned: Total 1DEV burned so far
            current_qnc_price: Current QNC price (for post-transition)
            
        Returns:
            Burn requirement details
        """
        burn_ratio = total_one_dev_burned / self.config.total_onedev_supply
        
        # Check if we've transitioned to QNC
        if burn_ratio >= self.config.burn_threshold_percent / 100:
            # Transition complete - use QNC
            if current_qnc_price is None:
                # Use dynamic pricing from previous module
                qnc_price = self._get_default_qnc_price(node_type)
            else:
                qnc_price = current_qnc_price
                
            return {
                "token": "QNC",
                "amount": qnc_price,
                "burn_ratio": burn_ratio,
                "transition_complete": True,
                "method": "qnc_payment"
            }
        
        # Still in 1DEV burning phase
        base_burn = self._calculate_dynamic_burn(burn_ratio, node_type)
        
        # Apply minimum floor
        min_burn = self._get_min_burn(node_type)
        final_burn = max(base_burn, min_burn)
        
        # Round to nice numbers if enabled
        if self.config.round_to_nearest > 0:
            final_burn = round(final_burn / self.config.round_to_nearest) * self.config.round_to_nearest
            # Ensure we don't go below minimum after rounding
            final_burn = max(final_burn, min_burn)
        
        return {
            "token": "1DEV",
            "amount": round(final_burn, 0),  # Round to whole 1DEV
            "burn_ratio": burn_ratio,
            "burn_percentage": burn_ratio * 100,
            "transition_complete": False,
            "method": "one_dev_burn",
            "remaining_to_transition": (self.config.burn_threshold_percent / 100 - burn_ratio) * 100
        }
    
    def _calculate_dynamic_burn(self, burn_ratio: float, node_type: NodeType) -> float:
        """
        Calculate base burn amount using inverse curve
        More burned = lower requirement
        """
        # Inverse exponential curve
        # At 0% burned: initial_burn_amount (1,500)
        # At 90% burned: approaches minimum
        
        # Calculate progress (0 to 1, where 1 is 90% burned)
        progress = min(burn_ratio / (self.config.burn_threshold_percent / 100), 1.0)
        
        # Inverse curve: high at start, low at end
        # Using exponential decay
        decay_factor = math.exp(-progress * self.config.decay_factor)
        
        # Get initial price for this node type
        initial_price = self._get_initial_burn(node_type)
        min_price = self._get_min_burn(node_type)
        
        # Calculate burn amount
        burn_range = initial_price - min_price
        burn_amount = min_price + (burn_range * decay_factor)
        
        return burn_amount
    
    def _get_initial_burn(self, node_type: NodeType) -> float:
        """Get initial burn amount for node type"""
        return {
            NodeType.LIGHT: self.config.light_node_start,
            NodeType.FULL: self.config.full_node_start,
            NodeType.SUPER: self.config.super_node_start
        }[node_type]
    
    def _get_min_burn(self, node_type: NodeType) -> float:
        """Get minimum burn for node type"""
        return {
            NodeType.LIGHT: self.config.light_node_min,
            NodeType.FULL: self.config.full_node_min,
            NodeType.SUPER: self.config.super_node_min
        }[node_type]
    
    def _get_default_qnc_price(self, node_type: NodeType) -> float:
        """Get default QNC price after transition"""
        # These would come from dynamic pricing model
        return {
            NodeType.LIGHT: self.config.light_node_start,
            NodeType.FULL: self.config.full_node_start,
            NodeType.SUPER: self.config.super_node_start
        }[node_type]
    
    def get_burn_schedule(self, total_onedev_burned: float) -> Dict[str, Dict]:
        """Get current burn requirements for all node types"""
        schedule = {}
        for node_type in NodeType:
            schedule[node_type.value] = self.calculate_burn_requirement(
                node_type, total_onedev_burned
            )
        return schedule
    
    def estimate_onedev_value_preservation(
        self,
        onedev_holdings: float,
        total_onedev_burned: float
    ) -> Dict[str, float]:
        """
        Estimate value preservation for 1DEV holders
        As supply decreases, remaining 1DEV becomes more valuable
        """
        burn_ratio = total_onedev_burned / self.config.total_onedev_supply
        remaining_supply = self.config.total_onedev_supply - total_onedev_burned
        
        # Scarcity multiplier - as supply decreases, value increases
        # Using logarithmic scale
        scarcity_factor = 1 + math.log10(1 + burn_ratio * 9)  # 1x to ~2x
        
        # Calculate implied value
        base_value = onedev_holdings
        adjusted_value = base_value * scarcity_factor
        
        return {
            "onedev_holdings": onedev_holdings,
            "burn_ratio": burn_ratio,
            "remaining_supply": remaining_supply,
            "scarcity_multiplier": scarcity_factor,
            "implied_value": adjusted_value,
            "value_increase_percent": (scarcity_factor - 1) * 100
        }

class BurnProgressTracker:
    """Tracks and analyzes 1DEV burn progress"""
    
    def __init__(self, total_supply: float = 1_000_000_000):
        self.total_supply = total_supply
        self.milestones = [0.1, 0.25, 0.5, 0.75, 0.9]  # 10%, 25%, 50%, 75%, 90%
    
    def analyze_burn_progress(
        self,
        total_burned: float,
        burn_rate_per_day: float
    ) -> Dict[str, any]:
        """Analyze burn progress and estimate timeline"""
        burn_ratio = total_burned / self.total_supply
        
        # Find next milestone
        next_milestone = None
        for milestone in self.milestones:
            if burn_ratio < milestone:
                next_milestone = milestone
                break
        
        # Estimate time to next milestone
        if next_milestone and burn_rate_per_day > 0:
            remaining_to_milestone = (next_milestone - burn_ratio) * self.total_supply
            days_to_milestone = remaining_to_milestone / burn_rate_per_day
        else:
            days_to_milestone = None
        
        # Estimate time to 90% (transition)
        if burn_ratio < 0.9 and burn_rate_per_day > 0:
            remaining_to_transition = (0.9 - burn_ratio) * self.total_supply
            days_to_transition = remaining_to_transition / burn_rate_per_day
        else:
            days_to_transition = 0
        
        return {
            "total_burned": total_burned,
            "burn_ratio": burn_ratio,
            "burn_percentage": burn_ratio * 100,
            "next_milestone": next_milestone,
            "next_milestone_percent": next_milestone * 100 if next_milestone else None,
            "days_to_next_milestone": days_to_milestone,
            "days_to_transition": days_to_transition,
            "current_phase": self._get_burn_phase(burn_ratio),
            "milestones_reached": [m for m in self.milestones if burn_ratio >= m]
        }
    
    def _get_burn_phase(self, burn_ratio: float) -> str:
        """Determine current burn phase"""
        if burn_ratio < 0.1:
            return "initial"
        elif burn_ratio < 0.25:
            return "early"
        elif burn_ratio < 0.5:
            return "active"
        elif burn_ratio < 0.75:
            return "mature"
        elif burn_ratio < 0.9:
            return "final"
        else:
            return "transition"

# Example usage and testing
if __name__ == "__main__":
    calculator = OneDevBurnCalculator()
    
    # Test burn requirements at different stages
    test_burns = [
        0,  # 0% burned
        100_000_000,  # 10% burned
        250_000_000,  # 25% burned
        500_000_000,  # 50% burned
        750_000_000,  # 75% burned
        850_000_000,  # 85% burned
        890_000_000,  # 89% burned
        900_000_000,  # 90% burned - transition point
    ]
    
    print("1DEV Burn Requirements by Progress:\n")
    
    for burned in test_burns:
        burn_percent = (burned / 1_000_000_000) * 100
        print(f"--- {burn_percent:.0f}% 1DEV Burned ({burned:,} 1DEV) ---")
        
        schedule = calculator.get_burn_schedule(burned)
        for node_type, details in schedule.items():
            print(f"{node_type}: {details['amount']:,.0f} {details['token']}")
        
        print()
    
    # Test value preservation
    print("\nValue Preservation Example:")
    holder_onedev = 100_000  # Holder has 100K 1DEV
    burned = 500_000_000  # 50% burned
    
    value_info = calculator.estimate_onedev_value_preservation(holder_onedev, burned)
    print(f"Holder with {holder_onedev:,} 1DEV at {value_info['burn_ratio']*100:.0f}% burn:")
    print(f"Scarcity multiplier: {value_info['scarcity_multiplier']:.2f}x")
    print(f"Implied value increase: {value_info['value_increase_percent']:.1f}%") 