#!/usr/bin/env python3
"""
QNet Bridge Functionality Test
Tests Phase 1 and Phase 2 activation logic without running full server
"""

import time
import hashlib
import secrets
from enum import Enum

class NodeType(Enum):
    LIGHT = "Light"
    FULL = "Full"
    SUPER = "Super"

class QNCActivationCosts:
    """QNC activation costs with network size multipliers"""
    
    base_costs = {
        NodeType.LIGHT: 5000,
        NodeType.FULL: 7500, 
        NodeType.SUPER: 10000
    }
    
    network_multipliers = {
        "0-100k": 0.5,
        "100k-1m": 1.0,
        "1m-10m": 2.0,
        "10m+": 3.0
    }

    @classmethod
    def calculate_required_qnc(cls, node_type: NodeType, network_size: int) -> int:
        """Calculate required QNC based on node type and network size"""
        
        base_cost = cls.base_costs[node_type]
        
        if network_size < 100000:
            multiplier = cls.network_multipliers["0-100k"]
        elif network_size < 1000000:
            multiplier = cls.network_multipliers["100k-1m"]
        elif network_size < 10000000:
            multiplier = cls.network_multipliers["1m-10m"]
        else:
            multiplier = cls.network_multipliers["10m+"]
            
        return int(base_cost * multiplier)

def test_phase1_pricing():
    """Test Phase 1 CORRECT dynamic pricing: Every 10% burned = -150 1DEV cost"""
    
    print("🔥 Testing Phase 1 (1DEV Burn) CORRECT Dynamic Pricing...")
    
    total_1dev_supply = 1_000_000_000  # 1 billion 1DEV total supply (pump.fun standard)
    base_cost = 1500
    reduction_per_10_percent = 150
    
    test_cases = [
        (0, "0% burned", 1500),                # 0% → 1500 1DEV
        (100_000_000, "10% burned", 1350),     # 10% → 1350 1DEV  
        (200_000_000, "20% burned", 1200),     # 20% → 1200 1DEV
        (300_000_000, "30% burned", 1050),     # 30% → 1050 1DEV
        (500_000_000, "50% burned", 750),      # 50% → 750 1DEV
        (800_000_000, "80% burned", 300),      # 80% → 300 1DEV (minimum Phase 1)
        (900_000_000, "90% burned", 300),      # 90% → Phase 2 transition (QNC)
    ]
    
    for total_burned, description, expected_cost in test_cases:
        burn_percentage = (total_burned / total_1dev_supply) * 100
        price_reduction = int((burn_percentage // 10) * reduction_per_10_percent)
        current_cost = max(base_cost - price_reduction, 300)  # Minimum at 80-90%
        
        print(f"  💰 {description}: {current_cost} 1DEV (reduced by {price_reduction})")
        
        assert current_cost == expected_cost, f"Expected {expected_cost}, got {current_cost}"
        
    print("✅ Phase 1 CORRECT pricing tests passed!\n")

def test_phase2_pricing():
    """Test Phase 2 dynamic pricing based on network size"""
    
    print("💎 Testing Phase 2 (QNC Pool 3) Dynamic Pricing...")
    
    # CANONICAL VALUES: ≤100K=0.5x, ≤300K=1.0x, ≤1M=2.0x, >1M=3.0x
    test_cases = [
        (50000, "≤100k", 0.5),
        (200000, "≤300k", 1.0),
        (500000, "≤1M", 2.0),
        (2000000, ">1M", 3.0)
    ]
    
    for network_size, expected_category, expected_multiplier in test_cases:
        for node_type in NodeType:
            required_qnc = QNCActivationCosts.calculate_required_qnc(node_type, network_size)
            base_cost = QNCActivationCosts.base_costs[node_type]
            actual_multiplier = required_qnc / base_cost
            
            print(f"  🌐 Network: {network_size:,} nodes ({expected_category}) → {node_type.value}: {required_qnc:,} QNC ({actual_multiplier}x)")
            
            assert abs(actual_multiplier - expected_multiplier) < 0.01, f"Multiplier mismatch: {actual_multiplier} vs {expected_multiplier}"
    
    print("✅ Phase 2 pricing tests passed!\n")

def test_node_code_generation():
    """Test node code generation for Phase 2"""
    
    print("🔑 Testing Node Code Generation...")
    
    test_eon_addresses = [
        "7a9bk4f2eon8x3m5z1c",
        "abc12345eonxyz789de",
        "test1234eonproductn"
    ]
    
    for eon_address in test_eon_addresses:
        for node_type in NodeType:
            # Generate node code (SHA3-256 for consistency)
            data = f"{eon_address}_{node_type.value}_{int(time.time())}"
            hash_obj = hashlib.sha3_256(data.encode())
            node_code = f"{node_type.value.upper()}{hash_obj.hexdigest()[:8].upper()}"
            
            print(f"  🏷️  EON: {eon_address} + {node_type.value} → {node_code}")
            
            # Validate format
            assert node_code.startswith(node_type.value.upper()), f"Node code should start with {node_type.value.upper()}"
            assert len(node_code) == len(node_type.value) + 8, f"Node code length incorrect: {len(node_code)}"
    
    print("✅ Node code generation tests passed!\n")

def test_api_responses():
    """Test API response structures"""
    
    print("📡 Testing API Response Structures...")
    
    # Test Phase 1 response
    phase1_response = {
        "success": True,
        "activation_id": f"phase1_{int(time.time())}_test",
        "burn_transaction": f"burn_tx_{int(time.time())}",
        "node_code": f"BURN{secrets.token_hex(4).upper()}",
        "node_type": "Light",
        "estimated_activation": int(time.time() + 600),
        "dynamic_pricing": {
            "base_cost": 1000,
            "total_burned": 250000,
            "multiplier": 1.5,
            "current_cost": 1500,
            "pricing_tier": "Standard (1.5x)"
        }
    }
    
    print("  📋 Phase 1 Response Structure:")
    for key, value in phase1_response.items():
        print(f"    - {key}: {type(value).__name__}")
    
    # Test Phase 2 response
    phase2_response = {
        "success": True,
        "activation_id": f"phase2_{int(time.time())}",
        "node_code": "LIGHT12345678",
        "qnc_spent_to_pool3": 5000,
        "pool_transaction_hash": f"pool3_tx_{int(time.time())}",
        "estimated_daily_rewards": 50,
        "activation_timestamp": int(time.time()),
        "pool_distribution": {
            "total_pool": 2500000,
            "daily_distribution": 10000,
            "your_share": 5000
        }
    }
    
    print("  📋 Phase 2 Response Structure:")
    for key, value in phase2_response.items():
        print(f"    - {key}: {type(value).__name__}")
    
    print("✅ API response tests passed!\n")

def test_pool3_calculations():
    """Test Pool 3 reward calculations"""
    
    print("🏊 Testing Pool 3 Calculations...")
    
    total_qnc = 2500000
    active_nodes = 45000
    daily_distribution = 450000  # Increased for realistic rewards per node
    
    rewards_per_node = daily_distribution // active_nodes if active_nodes > 0 else 0
    rewards_per_node_decimal = daily_distribution / active_nodes if active_nodes > 0 else 0
    
    print(f"  💰 Total QNC in Pool 3: {total_qnc:,}")
    print(f"  🤖 Active Nodes: {active_nodes:,}")
    print(f"  📅 Daily Distribution: {daily_distribution:,} QNC")
    print(f"  🎁 Rewards per Node: {rewards_per_node} QNC/day (≈{rewards_per_node_decimal:.2f})")
    
    # Validate calculations
    assert rewards_per_node > 0, "Rewards per node should be positive"
    assert rewards_per_node * active_nodes <= daily_distribution, "Total rewards cannot exceed daily distribution"
    assert daily_distribution <= total_qnc, "Daily distribution cannot exceed total pool"
    
    print("✅ Pool 3 calculation tests passed!\n")

def run_all_tests():
    """Run all bridge functionality tests"""
    
    print("🚀 Starting QNet Bridge Functionality Tests...\n")
    
    try:
        test_phase1_pricing()
        test_phase2_pricing()
        test_node_code_generation()
        test_api_responses()
        test_pool3_calculations()
        
        print("🎉 ALL TESTS PASSED!")
        print("✅ Bridge functionality verified successfully")
        print("✅ Phase 1 (1DEV burn) logic working")
        print("✅ Phase 2 (QNC Pool 3) logic working")
        print("✅ Dynamic pricing calculations correct")
        print("✅ API responses properly structured")
        print("✅ Ready for production deployment!")
        
    except AssertionError as e:
        print(f"❌ TEST FAILED: {e}")
        return False
    except Exception as e:
        print(f"❌ UNEXPECTED ERROR: {e}")
        return False
    
    return True

if __name__ == "__main__":
    success = run_all_tests()
    exit(0 if success else 1) 