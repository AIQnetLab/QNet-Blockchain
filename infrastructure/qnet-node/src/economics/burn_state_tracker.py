"""
Burn State Tracker
Tracks QNA burn progress from blockchain data
"""

from typing import Dict, Optional, Tuple
from datetime import datetime
import json
import os

class BurnStateTracker:
    """
    Tracks QNA burn state from blockchain
    This is the source of truth for pricing calculations
    """
    
    def __init__(self, blockchain_interface=None, cache_path: str = "data/burn_state.json"):
        self.blockchain = blockchain_interface
        self.cache_path = cache_path
        self.state_cache = self._load_cache()
        
    def _load_cache(self) -> Dict:
        """Load cached burn state for offline operation"""
        if os.path.exists(self.cache_path):
            try:
                with open(self.cache_path, 'r') as f:
                    return json.load(f)
            except:
                pass
        return {
            "total_burned": 0,
            "last_update": None,
            "network_launch_date": None
        }
    
    def get_current_burn_state(self) -> Dict[str, any]:
        """
        Get current burn state from blockchain or cache
        
        Returns:
            {
                "total_burned": int,  # Total QNA burned
                "burn_percentage": float,  # Percentage of supply burned
                "days_since_launch": int,  # Days since network launch
                "data_source": str  # "blockchain" or "cache"
            }
        """
        # Try to get fresh data from blockchain
        if self.blockchain and self._should_update():
            try:
                fresh_state = self._fetch_from_blockchain()
                self._update_cache(fresh_state)
                return {
                    **fresh_state,
                    "data_source": "blockchain"
                }
            except Exception as e:
                print(f"Failed to fetch from blockchain: {e}")
        
        # Fallback to cache
        return {
            "total_burned": self.state_cache.get("total_burned", 0),
            "burn_percentage": (self.state_cache.get("total_burned", 0) / 10_000_000_000) * 100,
            "days_since_launch": self._calculate_days_since_launch(),
            "data_source": "cache"
        }
    
    def _should_update(self) -> bool:
        """Check if we should fetch fresh data"""
        last_update = self.state_cache.get("last_update")
        if not last_update:
            return True
        
        # Update every 5 minutes
        last_update_time = datetime.fromisoformat(last_update)
        time_diff = datetime.now() - last_update_time
        return time_diff.total_seconds() > 300
    
    def _fetch_from_blockchain(self) -> Dict:
        """Fetch burn data from blockchain"""
        # This would connect to actual blockchain
        # For now, return mock data
        # In production, this would:
        # 1. Query Solana for burn address balance
        # 2. Calculate total burned
        # 3. Get network launch timestamp
        
        # Mock implementation
        return {
            "total_burned": 2_500_000_000,  # 25% burned
            "network_launch_date": "2024-01-01T00:00:00"
        }
    
    def _calculate_days_since_launch(self) -> int:
        """Calculate days since network launch"""
        launch_date_str = self.state_cache.get("network_launch_date")
        if not launch_date_str:
            return 0
        
        launch_date = datetime.fromisoformat(launch_date_str)
        return (datetime.now() - launch_date).days
    
    def _update_cache(self, state: Dict):
        """Update local cache"""
        self.state_cache.update({
            **state,
            "last_update": datetime.now().isoformat()
        })
        
        # Save to file
        os.makedirs(os.path.dirname(self.cache_path), exist_ok=True)
        with open(self.cache_path, 'w') as f:
            json.dump(self.state_cache, f, indent=2)
    
    def check_transition_status(self) -> Tuple[bool, str]:
        """
        Check if we should transition to QNC
        
        Returns:
            (should_transition, reason)
        """
        state = self.get_current_burn_state()
        
        # Check burn percentage
        if state["burn_percentage"] >= 90:
            return True, "90% of QNA supply burned"
        
        # Check time limit
        if state["days_since_launch"] >= (5 * 365):
            return True, "5 years since launch"
        
        return False, "Transition conditions not met"

class ConfigManager:
    """
    Manages static configuration vs dynamic state
    Config.ini contains ONLY static parameters that never change
    """
    
    @staticmethod
    def get_pricing_parameters(config, burn_tracker: BurnStateTracker) -> Dict:
        """
        Combine static config with dynamic burn state
        
        Args:
            config: AppConfig instance
            burn_tracker: BurnStateTracker instance
            
        Returns:
            Complete parameters for pricing calculation
        """
        # Static from config (never changes)
        static_params = {
            # Initial prices (used in formula, not actual prices)
            "initial_burn_light": config.getint("Token", "qna_initial_burn_light") / 1_000_000,
            "initial_burn_full": config.getint("Token", "qna_initial_burn_full") / 1_000_000,
            "initial_burn_super": config.getint("Token", "qna_initial_burn_super") / 1_000_000,
            
            # Minimum prices (floor values)
            "min_burn_light": config.getint("Token", "qna_min_burn_light") / 1_000_000,
            "min_burn_full": config.getint("Token", "qna_min_burn_full") / 1_000_000,
            "min_burn_super": config.getint("Token", "qna_min_burn_super") / 1_000_000,
            
            # Supply parameters (constants)
            "total_supply": config.getint("Token", "qna_total_supply") / 1_000_000,
            "burn_target_ratio": config.getfloat("Token", "qna_burn_target_ratio"),
            "transition_years": config.getint("Token", "qna_transition_years")
        }
        
        # Dynamic from blockchain
        burn_state = burn_tracker.get_current_burn_state()
        
        # Check if we should use QNC
        should_transition, _ = burn_tracker.check_transition_status()
        
        return {
            **static_params,
            "total_burned": burn_state["total_burned"],
            "burn_percentage": burn_state["burn_percentage"],
            "days_since_launch": burn_state["days_since_launch"],
            "use_qnc": should_transition,
            "data_source": burn_state["data_source"]
        }

# Example usage
if __name__ == "__main__":
    # Initialize tracker
    tracker = BurnStateTracker()
    
    # Get current state
    state = tracker.get_current_burn_state()
    print("Current Burn State:")
    print(f"  Total burned: {state['total_burned']:,} QNA")
    print(f"  Burn percentage: {state['burn_percentage']:.2f}%")
    print(f"  Days since launch: {state['days_since_launch']}")
    print(f"  Data source: {state['data_source']}")
    
    # Check transition
    should_transition, reason = tracker.check_transition_status()
    print(f"\nTransition to QNC: {should_transition}")
    print(f"Reason: {reason}")
    
    # Example config usage
    print("\nConfig Usage:")
    print("- Config.ini contains STATIC values (initial prices, minimums)")
    print("- Blockchain provides DYNAMIC state (burn progress)")
    print("- Pricing calculator uses BOTH to determine current price") 