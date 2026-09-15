"""
Dynamic Pricing Model for Node Activation
Supports any number of nodes from 100 to millions
"""

import math
from typing import Dict, Tuple
from dataclasses import dataclass
from enum import Enum

class NodeType(Enum):
    # v3.18: Only Light and Super nodes (Full removed)
    LIGHT = "light"
    SUPER = "super"

@dataclass
class PricingConfig:
    """Configuration for Phase 2 QNC node activation pricing"""
    # CORRECT Phase 2 Base prices (QNC)
    # v3.18: Only Light and Super nodes (Full removed)
    light_base_price: float = 10_000  # Light node base cost (10,000 QNC)
    super_base_price: float = 7_500   # Super node base cost (7,500 QNC)
    
    # Network size multipliers (CORRECT implementation)
    multiplier_0_100k: float = 0.5     # 0-100k nodes: 0.5x
    multiplier_100k_300k: float = 1.0  # 100k-300k nodes: 1.0x
    multiplier_300k_1m: float = 2.0    # 300k-1M nodes: 2.0x
    multiplier_1m_plus: float = 3.0    # 1M+ nodes: 3.0x
    
    # Target equilibrium points
    target_total_nodes: int = 100_000
    # v3.18: Only Light and Super nodes
    target_light_ratio: float = 0.90  # 90% light nodes (mobile)
    target_super_ratio: float = 0.10  # 10% super nodes (servers)
    
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
        CORRECT Phase 2 QNC pricing: base price * network size multiplier
        
        Args:
            node_type: Type of node to activate
            active_nodes: Current count of active nodes by type
            
        Returns:
            Price in QNC tokens
        """
        total_active = sum(active_nodes.values())
        
        # Get base price for node type
        base_price = self._get_base_price(node_type)
        
        # Get network size multiplier
        multiplier = self._get_network_multiplier(total_active)
        
        # Calculate final price
        final_price = base_price * multiplier
        
        return int(final_price)
    
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
    
    def _get_base_price(self, node_type: NodeType) -> float:
        """Get base price for node type (Phase 2 QNC)
        v3.18: Only Light (10,000 QNC) and Super (7,500 QNC) - Full removed
        """
        return {
            NodeType.LIGHT: self.config.light_base_price,    # 10,000 QNC
            NodeType.SUPER: self.config.super_base_price     # 7,500 QNC
        }.get(node_type, self.config.light_base_price)
    
    def _get_network_multiplier(self, total_nodes: int) -> float:
        """Get network size multiplier for CORRECT Phase 2 pricing
        CANONICAL VALUES - same across all components (Rust, Python, JS)
        """
        if total_nodes <= 100_000:
            return self.config.multiplier_0_100k       # ≤100K: 0.5x
        elif total_nodes <= 300_000:
            return self.config.multiplier_100k_300k    # ≤300K: 1.0x
        elif total_nodes <= 1_000_000:
            return self.config.multiplier_300k_1m      # ≤1M: 2.0x
        else:
            return self.config.multiplier_1m_plus      # >1M: 3.0x
    
    def _get_target_count(self, node_type: NodeType, total_target: int) -> int:
        """Get target count for node type - v3.18: Only Light and Super"""
        ratios = {
            NodeType.LIGHT: self.config.target_light_ratio,
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
    """Handles 1DEV to QNC transition pricing"""
    
    def __init__(self):
        self.transition_period_days = 90
        self.onedev_burn_target = 0.9  # 90% of supply
        self.max_transition_years = 5
    
    def calculate_1dev_burn_amount(
        self,
        node_type: NodeType,
        qnc_price: float,
        onedev_burned_ratio: float,
        days_since_launch: int
    ) -> Tuple[float, str]:
        """
        Calculate 1DEV burn amount during transition period
        
        Returns:
            (burn_amount, pricing_method)
        """
        # Check if we should transition to QNC
        years_passed = days_since_launch / 365
        
        if onedev_burned_ratio >= self.onedev_burn_target or years_passed >= self.max_transition_years:
            # Transition complete - use QNC only
            return (0, "qnc_only")
        
        # During transition - 1DEV burn equals QNC price
        # This creates 1:1 value preservation
        return (qnc_price, "1dev_burn")
    
    def get_transition_status(
        self,
        onedev_burned_ratio: float,
        days_since_launch: int
    ) -> Dict[str, any]:
        """Get current transition status"""
        years_passed = days_since_launch / 365
        transition_complete = (
            onedev_burned_ratio >= self.onedev_burn_target or 
            years_passed >= self.max_transition_years
        )
        
        return {
            "transition_complete": transition_complete,
            "onedev_burned_percent": onedev_burned_ratio * 100,
            "years_elapsed": years_passed,
            "burn_target_percent": self.onedev_burn_target * 100,
            "max_years": self.max_transition_years,
            "method": "qnc_only" if transition_complete else "1dev_burn"
        }

# Example usage
if __name__ == "__main__":
    calculator = DynamicPricingCalculator()
    
    # Test different network sizes
    # v3.18: Only Light and Super nodes (Full removed)
    test_scenarios = [
        {"light": 90, "super": 10},      # 100 nodes
        {"light": 900, "super": 100},   # 1K nodes
        {"light": 9000, "super": 1000}, # 10K nodes
        {"light": 90000, "super": 10000}, # 100K nodes
        {"light": 900000, "super": 100000}, # 1M nodes
    ]
    
    for scenario in test_scenarios:
        active_nodes = {
            NodeType.LIGHT: scenario["light"],
            NodeType.SUPER: scenario["super"]
        }
        total = sum(scenario.values())
        
        print(f"\n--- Network with {total:,} nodes ---")
        prices = calculator.get_price_schedule(active_nodes)
        for node_type, price in prices.items():
            print(f"{node_type.value}: {price:,.2f} QNC")
        
        network_value = calculator.estimate_network_value(active_nodes)
        print(f"Total network value: {network_value:,.2f} QNC") 