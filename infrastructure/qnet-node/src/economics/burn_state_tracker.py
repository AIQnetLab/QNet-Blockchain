"""
Tracks 1DEV burn progress from blockchain data - PRODUCTION VERSION
"""

import time
import requests
from typing import Dict, Optional, Tuple
from dataclasses import dataclass

@dataclass
class BurnState:
    """Current burn state snapshot"""
    total_burned: int
    burn_percentage: float
    burn_transactions: int
    last_update: int
    data_source: str

class BurnStateTracker:
    """
    Tracks 1DEV burn state from blockchain
    Reads from Solana to get real burn data - PRODUCTION ONLY
    """
    
    def __init__(self):
        # PRODUCTION TOKEN SETTINGS
        self.onedev_mint = "62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ"
        self.mint_authority = "6gesV5Dojg9tfH9TRytvXabnQT8U7oMbz5VKpTFi8rG4"
        self.onedev_total_supply = 1_000_000_000  # 1 billion tokens
        self.burn_address = "1nc1nerator11111111111111111111111111111111"
        self.solana_rpc = "https://api.devnet.solana.com"
        
        # Cache settings
        self.cache_duration = 300  # 5 minutes
        self.last_update = 0
        self.cached_state: Optional[BurnState] = None
        
    def get_current_burn_state(self) -> Dict[str, any]:
        """
        Get current burn state with caching
        
        Returns:
            Dictionary with burn state data
        """
        current_time = int(time.time())
        
        # Check cache validity
        if (self.cached_state and 
            current_time - self.last_update < self.cache_duration):
            return self._state_to_dict(self.cached_state)
        
        # Fetch fresh data - PRODUCTION ONLY
        state = self._fetch_burn_state_from_blockchain()
        self.cached_state = state
        self.last_update = current_time
        
        # Add time progress information
        result = self._state_to_dict(state)
        result.update(self._get_time_progress())
        return result
    
    def _fetch_burn_state_from_blockchain(self) -> BurnState:
        """
        Fetch actual burn state from Solana blockchain - PRODUCTION VERSION
        """
        try:
            # Get token supply via RPC
            supply_response = self._rpc_call("getTokenSupply", [self.onedev_mint])
            if not supply_response.get('result'):
                raise Exception("Failed to get token supply")
            
            current_supply = int(supply_response['result']['value']['amount'])
            total_supply_raw = self.onedev_total_supply * 1_000_000  # 6 decimals
            
            # Calculate burned amount
            burned_amount = total_supply_raw - current_supply
            burned_tokens = burned_amount / 1_000_000  # Convert to tokens
            
            # Calculate burn percentage
            burn_percentage = (burned_tokens / self.onedev_total_supply) * 100
            
            print(f"🔥 PRODUCTION Burn Data:")
            print(f"   Total Supply: {self.onedev_total_supply:,} 1DEV")
            print(f"   Current Supply: {current_supply / 1_000_000:,.0f} 1DEV")
            print(f"   Burned: {burned_tokens:,.0f} 1DEV ({burn_percentage:.2f}%)")
            
            return BurnState(
                total_burned=int(burned_tokens),
                burn_percentage=burn_percentage,
                burn_transactions=int(burned_tokens / 1500),  # Estimate based on 1500 1DEV per burn
                last_update=int(time.time()),
                data_source="solana_devnet_production"
            )
            
        except Exception as e:
            print(f"❌ PRODUCTION ERROR: Failed to fetch burn state: {e}")
            raise Exception(f"Burn state tracker failed in production mode: {e}")
    
    def _rpc_call(self, method: str, params: list) -> Dict:
        """Make RPC call to Solana"""
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params
        }
        
        response = requests.post(
            self.solana_rpc,
            json=payload,
            headers={"Content-Type": "application/json"},
            timeout=30
        )
        
        if response.status_code != 200:
            raise Exception(f"RPC call failed: {response.status_code}")
        
        return response.json()
    
    def _state_to_dict(self, state: BurnState) -> Dict[str, any]:
        """Convert BurnState to dictionary"""
        return {
            "total_burned": state.total_burned,
            "burn_percentage": state.burn_percentage,
            "burn_transactions": state.burn_transactions,
            "last_update": state.last_update,
            "data_source": state.data_source,
            "cache_hit": state.last_update == self.last_update
        }
    
    def _get_time_progress(self) -> Dict[str, any]:
        """Get time-based progress information"""
        try:
            # Try to get genesis timestamp from QNet node
            genesis_response = requests.get(
                "http://localhost:8080/api/v1/blockchain/genesis",
                timeout=5
            )
            
            if genesis_response.status_code == 200:
                genesis_data = genesis_response.json()
                genesis_timestamp = genesis_data.get('timestamp', 0)
                
                if genesis_timestamp > 0:
                    days_elapsed = (int(time.time()) - genesis_timestamp) / 86400
                    return {
                        "genesis_available": True,
                        "days_elapsed": days_elapsed,
                        "years_elapsed": days_elapsed / 365.25,
                        "phase_transition_at": "90% burned OR 5 years (1825 days)"
                    }
            
        except Exception:
            pass
        
        return {
            "genesis_available": False,
            "estimated_days": "Unknown - genesis not available"
        }

# PRODUCTION TEST FUNCTION
def test_production_burn_tracker():
    """Test burn tracker in production mode"""
    print("🔥 1DEV Burn State Tracker - PRODUCTION TEST")
    print("=" * 48)
    
    tracker = BurnStateTracker()
    
    try:
        state = tracker.get_current_burn_state()
        
        print(f"✅ PRODUCTION SUCCESS:")
        print(f"   Data source: {state['data_source']}")
        print(f"   Total burned: {state['total_burned']:,} 1DEV")
        print(f"   Burn percentage: {state['burn_percentage']:.2f}%")
        print(f"   Last update: {state['last_update']}")
        print(f"   Cache hit: {state['cache_hit']}")
        
        if 'days_elapsed' in state:
            print(f"   Days elapsed: {state['days_elapsed']:.1f}")
        
        return True
        
    except Exception as e:
        print(f"❌ PRODUCTION FAILURE: {e}")
        return False

if __name__ == "__main__":
    test_production_burn_tracker() 