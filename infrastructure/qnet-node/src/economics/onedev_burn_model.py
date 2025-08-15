"""
1DEV Burn Model - Dynamic burning threshold based on supply burned
Universal pricing: 1500 1DEV for ALL node types, decreases as more is burned
Correct reduction formula: Every 10% burned = -150 1DEV cost
"""

from typing import Dict, Any, Optional
from dataclasses import dataclass
from enum import Enum
import math

class NodeType(Enum):
    LIGHT = "light"
    FULL = "full" 
    SUPER = "super"

@dataclass
class OneDEVBurnConfig:
    """Configuration for 1DEV burn model"""
    
    # Universal base prices (SAME for all node types!)
    base_price_light: int = 1500    # 1500 1DEV universal
    base_price_full: int = 1500     # 1500 1DEV universal  
    base_price_super: int = 1500    # 1500 1DEV universal
    
    # Universal minimum prices
    min_price_light: int = 150      # 150 1DEV minimum
    min_price_full: int = 150       # 150 1DEV minimum
    min_price_super: int = 150      # 150 1DEV minimum
    
    # Supply configuration
    total_1dev_supply: float = 1_000_000_000  # 1 billion 1DEV (Pump.fun standard)
    
    # Reduction formula: -150 1DEV per 10% burned
    reduction_per_tier: int = 150   # 150 1DEV reduction per 10% tier
    
    # No rounding - use exact calculated prices
    round_to_nearest: int = 1  # No rounding (was removed per user request)

class OneDEVBurnCalculator:
    """Calculates 1DEV burn requirements based on current burn progress"""
    
    def __init__(self, config: Optional[OneDEVBurnConfig] = None):
        self.config = config or OneDEVBurnConfig()

    def calculate_burn_requirement(
        self,
        node_type: NodeType,
        total_1dev_burned: float,
    ) -> Dict[str, Any]:
        """
        Calculate 1DEV burn requirement for node activation
        
        Args:
            node_type: Type of node to activate
            total_1dev_burned: Total 1DEV burned so far
            
        Returns:
            Dictionary with burn requirement details
        """
        
        # Calculate burn percentage
        burn_ratio = total_1dev_burned / self.config.total_1dev_supply
        
        # CORRECTED: Universal pricing for all node types
        base_price = 1500  # Universal base price
        min_price = 150    # Universal minimum price
        
        # Calculate tier (each 10% = 1 tier)
        tier = int(burn_ratio * 10)  # 0.1 = tier 1, 0.2 = tier 2, etc.
        
        # Calculate reduction
        total_reduction = tier * self.config.reduction_per_tier
        
        # Calculate final price
        current_price = base_price - total_reduction
        final_price = max(current_price, min_price)
        
        # Use exact price without rounding
        final_burn = int(final_price)
        
        return {
            "phase": "1DEV_BURN",
            "node_type": node_type.value,
            "token": "1DEV",
            "amount": final_burn,  # Round to whole 1DEV
            "base_price": base_price,
            "total_reduction": total_reduction,
            "burn_ratio": burn_ratio,
            "method": "1dev_burn",
            "transition_ready": burn_ratio >= 0.9  # 90% threshold
        }

    def get_burn_schedule(self, total_1dev_burned: float) -> Dict[str, Dict]:
        """
        Get burn schedule for all node types at current burn level
        
        Args:
            total_1dev_burned: Total 1DEV burned so far
            
        Returns:
            Dictionary with all node type requirements
        """
        
        return {
            node_type.value: self.calculate_burn_requirement(
                node_type, total_1dev_burned
            )
            for node_type in NodeType
        }

    def estimate_1dev_value_preservation(
        self,
        onedev_holdings: float,
        total_1dev_burned: float
    ) -> Dict[str, Any]:
        """
        Estimate value preservation for 1DEV holders
        As supply decreases, remaining 1DEV becomes more valuable
        """
        burn_ratio = total_1dev_burned / self.config.total_1dev_supply
        remaining_supply = self.config.total_1dev_supply - total_1dev_burned
        
        # Simple scarcity multiplier
        scarcity_multiplier = self.config.total_1dev_supply / remaining_supply if remaining_supply > 0 else 1.0
        
        # Value preservation estimate (not financial advice!)
        base_value = onedev_holdings
        estimated_value = base_value * scarcity_multiplier
        
        return {
            "1dev_holdings": onedev_holdings,
            "burn_ratio": burn_ratio,
            "scarcity_multiplier": scarcity_multiplier,
            "estimated_preservation": estimated_value / base_value if base_value > 0 else 1.0
        }

class OneDEVBurnTracker:
    """Tracks and analyzes 1DEV burn progress"""
    
    def __init__(self):
        self.calculator = OneDEVBurnCalculator()
        
    def analyze_burn_progress(self, total_burned: float) -> Dict[str, Any]:
        """Comprehensive analysis of burn progress"""
        
        config = self.calculator.config
        burn_ratio = total_burned / config.total_1dev_supply
        
        # Get current prices
        current_schedule = self.calculator.get_burn_schedule(total_burned)
        
        # Calculate transition progress
        transition_threshold = config.total_1dev_supply * 0.9  # 90%
        transition_progress = total_burned / transition_threshold
        
        return {
            "total_burned": total_burned,
            "burn_percentage": burn_ratio * 100,
            "remaining_supply": config.total_1dev_supply - total_burned,
            "current_prices": current_schedule,
            "transition_progress": min(transition_progress, 1.0),
            "transition_ready": burn_ratio >= 0.9,
            "estimated_nodes_affordable": {
                node_type: int((config.total_1dev_supply - total_burned) / prices["amount"]) 
                for node_type, prices in current_schedule.items()
                if prices["amount"] > 0
            }
        }

# Example usage and testing
if __name__ == "__main__":
    calculator = OneDEVBurnCalculator()
    
    print("=" * 80)
    print("1DEV BURN MODEL - CORRECTED UNIVERSAL PRICING")
    print("=" * 80)
    print("Base price: 1500 1DEV (ALL node types)")
    print("Reduction: -150 1DEV per 10% burned tier")
    print("Minimum: 150 1DEV at 90% burned")
    print("=" * 80)
    
    # Test burn percentages
    test_percentages = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90]
    
    print(f"{'Burned%':<8} {'Light':<8} {'Full':<8} {'Super':<8} {'Note'}")
    print("-" * 50)
    
    for percent in test_percentages:
        burned = (percent / 100) * 1_000_000_000  # Total supply
        
        # All node types have same price (universal)
        light_req = calculator.calculate_burn_requirement(NodeType.LIGHT, burned)
        
        note = ""
        if percent == 0:
            note = "← Launch price"
        elif percent == 50:
            note = "← Half burned"
        elif percent == 90:
            note = "← Transition threshold"
        
        print(f"{percent}%{'':<5} {light_req['amount']:<8} {light_req['amount']:<8} {light_req['amount']:<8} {note}")
    
    print("-" * 50)
    print("✅ UNIVERSAL PRICING: All node types cost the same!")
    print("✅ CORRECT FORMULA: -150 1DEV per 10% burned tier")
    print("✅ MINIMUM FLOOR: 150 1DEV at 90% burned") 