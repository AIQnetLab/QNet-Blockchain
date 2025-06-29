"""
Transition Protection Module
Prevents price shocks during 1DEV to QNC transition
"""

from typing import Dict, Optional
from dataclasses import dataclass
from datetime import datetime, timedelta
import math

@dataclass
class TransitionProtectionConfig:
    """Configuration for transition protection mechanisms"""
    # Smooth transition period
    transition_smoothing_days: int = 90
    
    # Price protection
    max_daily_price_change: float = 0.1  # 10% max daily change
    price_buffer_zone: float = 0.05  # 5% buffer for stability
    
    # Network stability
    min_nodes_for_transition: int = 1000  # Minimum network size
    emergency_brake_threshold: float = 0.3  # 30% daily volatility triggers brake

class TransitionProtectionManager:
    """Manages protection mechanisms during token transition"""
    
    def __init__(self, config: TransitionProtectionConfig = None):
        self.config = config or TransitionProtectionConfig()
        self.transition_start_date: Optional[datetime] = None
        self.price_history: Dict[datetime, float] = {}
    
    def calculate_protected_price(
        self,
        base_price: float,
        previous_price: float,
        transition_progress: float
    ) -> float:
        """
        Calculate price with shock protection
        
        Args:
            base_price: Calculated market price
            previous_price: Yesterday's price
            transition_progress: 0-1 progress through transition
            
        Returns:
            Protected price with smoothing applied
        """
        if previous_price == 0:
            return base_price
        
        # Calculate price change
        price_change = (base_price - previous_price) / previous_price
        
        # Apply daily change limit
        if abs(price_change) > self.config.max_daily_price_change:
            # Limit the change
            max_change = self.config.max_daily_price_change
            if price_change > 0:
                protected_price = previous_price * (1 + max_change)
            else:
                protected_price = previous_price * (1 - max_change)
        else:
            protected_price = base_price
        
        # Apply smoothing based on transition progress
        # More smoothing early in transition, less later
        smoothing_factor = 1 - (transition_progress * 0.5)  # 100% to 50% smoothing
        
        final_price = (
            protected_price * smoothing_factor + 
            base_price * (1 - smoothing_factor)
        )
        
        return round(final_price, 2)
    
    def check_emergency_brake(
        self,
        recent_prices: list[float],
        time_window_hours: int = 24
    ) -> bool:
        """
        Check if emergency brake should be activated
        
        Returns:
            True if volatility exceeds threshold
        """
        if len(recent_prices) < 2:
            return False
        
        # Calculate volatility (standard deviation / mean)
        mean_price = sum(recent_prices) / len(recent_prices)
        variance = sum((p - mean_price) ** 2 for p in recent_prices) / len(recent_prices)
        std_dev = math.sqrt(variance)
        volatility = std_dev / mean_price if mean_price > 0 else 0
        
        return volatility > self.config.emergency_brake_threshold
    
    def calculate_transition_metrics(
        self,
        onedev_burned: float,
        onedev_total_supply: float,
        days_elapsed: int
    ) -> Dict[str, any]:
        """Calculate comprehensive transition metrics"""
        burn_ratio = onedev_burned / onedev_total_supply if onedev_total_supply > 0 else 0
        years_elapsed = days_elapsed / 365
        
        # Transition progress (0-1)
        burn_progress = min(burn_ratio / 0.9, 1.0)  # 90% burn target
        time_progress = min(years_elapsed / 5, 1.0)  # 5 year max
        overall_progress = max(burn_progress, time_progress)
        
        # Estimate completion
        if burn_ratio > 0:
            burn_rate_per_day = burn_ratio / max(days_elapsed, 1)
            remaining_to_burn = max(0.9 - burn_ratio, 0)
            estimated_days_to_90 = remaining_to_burn / burn_rate_per_day if burn_rate_per_day > 0 else float('inf')
        else:
            estimated_days_to_90 = float('inf')
        
        return {
            "burn_ratio": burn_ratio,
            "burn_percentage": burn_ratio * 100,
            "years_elapsed": years_elapsed,
            "overall_progress": overall_progress,
            "burn_progress": burn_progress,
            "time_progress": time_progress,
            "estimated_days_to_completion": min(estimated_days_to_90, (5 * 365) - days_elapsed),
            "transition_phase": self._get_transition_phase(overall_progress)
        }
    
    def _get_transition_phase(self, progress: float) -> str:
        """Determine current transition phase"""
        if progress < 0.1:
            return "early"
        elif progress < 0.5:
            return "active"
        elif progress < 0.9:
            return "late"
        else:
            return "final"

class PriceStabilizationMechanism:
    """Additional mechanisms for price stability during transition"""
    
    def __init__(self):
        self.stability_pool_size = 0
        self.intervention_history = []
    
    def calculate_stability_intervention(
        self,
        current_price: float,
        target_price: float,
        pool_size: float
    ) -> Dict[str, float]:
        """
        Calculate market intervention to stabilize price
        
        Returns:
            Intervention details (buy/sell amounts)
        """
        price_deviation = (current_price - target_price) / target_price
        
        if abs(price_deviation) < 0.02:  # Within 2% - no intervention
            return {"action": "none", "amount": 0}
        
        # Calculate intervention size (up to 10% of pool)
        max_intervention = pool_size * 0.1
        intervention_size = min(
            abs(price_deviation) * pool_size * 0.5,
            max_intervention
        )
        
        if price_deviation > 0:  # Price too high - sell to lower
            return {
                "action": "sell",
                "amount": intervention_size,
                "target_impact": -price_deviation * 0.5
            }
        else:  # Price too low - buy to raise
            return {
                "action": "buy", 
                "amount": intervention_size,
                "target_impact": -price_deviation * 0.5
            }

# Example usage
if __name__ == "__main__":
    protection = TransitionProtectionManager()
    
    # Test price protection
    base_price = 1000
    previous_price = 900
    
    protected_price = protection.calculate_protected_price(
        base_price=base_price,
        previous_price=previous_price,
        transition_progress=0.3
    )
    
    print(f"Base price: {base_price}")
    print(f"Previous price: {previous_price}")
    print(f"Protected price: {protected_price}")
    print(f"Change limited to: {((protected_price - previous_price) / previous_price * 100):.1f}%")
    
    # Test transition metrics  
    metrics = protection.calculate_transition_metrics(
        onedev_burned=850_000_000,  # 85% burned (850M out of 1B total supply)
        onedev_total_supply=1_000_000_000,  # 1 billion 1DEV total supply
        days_elapsed=730  # 2 years
    )
    print(f"\nTransition Metrics: {metrics}")
    print(f"Burn progress: {metrics['burn_percentage']:.1f}% of 1DEV supply") 
    print(f"Transition phase: {metrics['transition_phase']}")
    print(f"Estimated completion: {metrics['estimated_days_to_completion']:.0f} days") 