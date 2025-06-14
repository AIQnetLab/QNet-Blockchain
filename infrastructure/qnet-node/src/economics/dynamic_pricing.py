"""
Dynamic Pricing Model for Node Activation
Supports any number of nodes from 100 to millions
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
class PricingConfig:
    """Configuration for node activation pricing"""
    # Base prices (in QNC/QNA)
    light_min_price: float = 2_500   # 0.5x multiplier
    light_max_price: float = 15_000  # 3x multiplier
    
    full_min_price: float = 3_750    # 0.5x multiplier
    full_max_price: float = 22_500   # 3x multiplier
    
    super_min_price: float = 5_000   # 0.5x multiplier
    super_max_price: float = 30_000  # 3x multiplier
    
    # Target equilibrium points
    target_total_nodes: int = 100_000
    target_light_ratio: float = 0.7  # 70% light nodes
    target_full_ratio: float = 0.25  # 25% full nodes
    target_super_ratio: float = 0.05  # 5% super nodes
    
    # Price curve parameters
    curve_steepness: float = 2.0  # Quadratic curve
    
    # Minimum viable network size
    min_network_size: int = 100

class DynamicPricingCalculator:
    """Calculates node activation prices based on network state"""
    
    def __init__(self, config: PricingConfig = None):
        self.config = config or PricingConfig()
    
    def calculate_price(
        self, 
        node_type: NodeType,
        active_nodes: Dict[NodeType, int]
    ) -> float:
        """
        Calculate activation price for a node type based on active nodes
        
        Args:
            node_type: Type of node to activate
            active_nodes: Current count of active nodes by type
            
        Returns:
            Price in QNC/QNA tokens
        """
        total_active = sum(active_nodes.values())
        
        # Handle edge cases
        if total_active < self.config.min_network_size:
            # Early network phase - use minimum prices
            return self._get_min_price(node_type)
        
        # Calculate network saturation (0 to 1+)
        saturation = total_active / self.config.target_total_nodes
        
        # Calculate type-specific saturation
        type_count = active_nodes.get(node_type, 0)
        target_count = self._get_target_count(node_type, self.config.target_total_nodes)
        type_saturation = type_count / max(target_count, 1)
        
        # Combined saturation factor (weighted average)
        combined_saturation = 0.7 * saturation + 0.3 * type_saturation
        
        # Calculate price using smooth curve
        price = self._calculate_curve_price(node_type, combined_saturation)
        
        return round(price, 2)
    
    def _calculate_curve_price(self, node_type: NodeType, saturation: float) -> float:
        """Calculate price using quadratic curve"""
        min_price = self._get_min_price(node_type)
        max_price = self._get_max_price(node_type)
        
        # Smooth quadratic curve: price = min + (max-min) * saturation^steepness
        # Capped at max_price for saturation > 1
        if saturation <= 0:
            return min_price
        elif saturation >= 1:
            # Apply logarithmic growth beyond target
            overflow = math.log(saturation + 1) - math.log(2)
            return min(max_price, max_price * (1 + overflow * 0.1))
        else:
            # Normal quadratic curve
            price_range = max_price - min_price
            curve_value = math.pow(saturation, self.config.curve_steepness)
            return min_price + price_range * curve_value
    
    def _get_min_price(self, node_type: NodeType) -> float:
        """Get minimum price for node type"""
        return {
            NodeType.LIGHT: self.config.light_min_price,
            NodeType.FULL: self.config.full_min_price,
            NodeType.SUPER: self.config.super_min_price
        }[node_type]
    
    def _get_max_price(self, node_type: NodeType) -> float:
        """Get maximum price for node type"""
        return {
            NodeType.LIGHT: self.config.light_max_price,
            NodeType.FULL: self.config.full_max_price,
            NodeType.SUPER: self.config.super_max_price
        }[node_type]
    
    def _get_target_count(self, node_type: NodeType, total_target: int) -> int:
        """Get target count for node type"""
        ratios = {
            NodeType.LIGHT: self.config.target_light_ratio,
            NodeType.FULL: self.config.target_full_ratio,
            NodeType.SUPER: self.config.target_super_ratio
        }
        return int(total_target * ratios[node_type])
    
    def get_price_schedule(self, active_nodes: Dict[NodeType, int]) -> Dict[NodeType, float]:
        """Get current prices for all node types"""
        return {
            node_type: self.calculate_price(node_type, active_nodes)
            for node_type in NodeType
        }
    
    def estimate_network_value(self, active_nodes: Dict[NodeType, int]) -> float:
        """Estimate total network value based on activation costs"""
        total_value = 0
        for node_type, count in active_nodes.items():
            avg_price = self.calculate_price(node_type, active_nodes)
            total_value += avg_price * count
        return total_value

class TransitionPricingModel:
    """Handles QNA to QNC transition pricing"""
    
    def __init__(self):
        self.transition_period_days = 90
        self.qna_burn_target = 0.9  # 90% of supply
        self.max_transition_years = 5
    
    def calculate_qna_burn_amount(
        self,
        node_type: NodeType,
        qnc_price: float,
        qna_burned_ratio: float,
        days_since_launch: int
    ) -> Tuple[float, str]:
        """
        Calculate QNA burn amount during transition period
        
        Returns:
            (burn_amount, pricing_method)
        """
        # Check if we should transition to QNC
        years_passed = days_since_launch / 365
        
        if qna_burned_ratio >= self.qna_burn_target or years_passed >= self.max_transition_years:
            # Transition complete - use QNC only
            return (0, "qnc_only")
        
        # During transition - QNA burn equals QNC price
        # This creates 1:1 value preservation
        return (qnc_price, "qna_burn")
    
    def get_transition_status(
        self,
        qna_burned_ratio: float,
        days_since_launch: int
    ) -> Dict[str, any]:
        """Get current transition status"""
        years_passed = days_since_launch / 365
        transition_complete = (
            qna_burned_ratio >= self.qna_burn_target or 
            years_passed >= self.max_transition_years
        )
        
        return {
            "transition_complete": transition_complete,
            "qna_burned_percent": qna_burned_ratio * 100,
            "years_elapsed": years_passed,
            "burn_target_percent": self.qna_burn_target * 100,
            "max_years": self.max_transition_years,
            "method": "qnc_only" if transition_complete else "qna_burn"
        }

# Example usage
if __name__ == "__main__":
    calculator = DynamicPricingCalculator()
    
    # Test different network sizes
    test_scenarios = [
        {"light": 70, "full": 25, "super": 5},      # 100 nodes
        {"light": 700, "full": 250, "super": 50},   # 1K nodes
        {"light": 7000, "full": 2500, "super": 500}, # 10K nodes
        {"light": 70000, "full": 25000, "super": 5000}, # 100K nodes
        {"light": 700000, "full": 250000, "super": 50000}, # 1M nodes
    ]
    
    for scenario in test_scenarios:
        active_nodes = {
            NodeType.LIGHT: scenario["light"],
            NodeType.FULL: scenario["full"],
            NodeType.SUPER: scenario["super"]
        }
        total = sum(scenario.values())
        
        print(f"\n--- Network with {total:,} nodes ---")
        prices = calculator.get_price_schedule(active_nodes)
        for node_type, price in prices.items():
            print(f"{node_type.value}: {price:,.2f} QNC")
        
        network_value = calculator.estimate_network_value(active_nodes)
        print(f"Total network value: {network_value:,.2f} QNC") 